package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	graphql "github.com/hasura/go-graphql-client"
	"github.com/stashapp/stash/pkg/plugin/common"
	"github.com/stashapp/stash/pkg/plugin/common/log"
	"github.com/stashapp/stash/pkg/plugin/util"
)

// PluginID must match the manifest filename (auto-vision-tagging.yml → "auto-vision-tagging").
const PluginID = "auto-vision-tagging"

// Log prefixes used for structured log-scraping by the JS layer.
//
// The plugin only falls back across hosts at SUBMIT time. Once a host accepts
// a job, all status polls and results fetches against that job stay on that
// same host for the lifetime of the task. There is therefore no
// fallbackEngaged=status or fallbackEngaged=results marker — if reads ever
// fail, the task fails and the user retries.
const (
	logPrefixTagResult      = "tagResult="
	logPrefixFallbackSubmit = "fallbackEngaged=submit"
)

// HTTP client timeouts for the auto-vision service. Each call creates a fresh
// http.Client so a lingering request from a previous poll can't bleed into
// the next one.
//
// The status / results timeouts are deliberately generous. When the
// semantics service's GPU worker is busy, its HTTP endpoints can stall for
// minutes at a time before yielding the event loop long enough to reply —
// previously seen in practice during a real classification run. Anything
// shorter produces a cascade of false-positive poll failures that clutter
// the log. 10 minutes per request is long enough to survive those stalls
// while jobTimeoutSeconds still bounds the overall task at 30 min default.
//
// Submit and sceneUpdate stay short because they talk to endpoints that
// return quickly under normal conditions (auto-vision's /analyze endpoint
// just enqueues a job; Stash's sceneUpdate writes a row). A long wait there
// would hide real problems instead of surfacing them.
const (
	httpSubmitTimeout  = 30 * time.Second
	httpStatusTimeout  = 10 * time.Minute
	httpResultsTimeout = 10 * time.Minute
)

// Deadline applied via context to the Stash sceneUpdate mutation. The Stash
// plugin util client itself has no HTTP timeout, so without this the
// mutation could hang indefinitely if the Stash server is slow or stalled.
const sceneUpdateTimeout = 30 * time.Second

// apiKind identifies which host we're talking to. Each kind has its own
// request body shape and its own set of URL paths.
type apiKind int

const (
	apiKindRollup apiKind = iota
	apiKindSemantics
)

func (k apiKind) String() string {
	switch k {
	case apiKindRollup:
		return "rollup"
	case apiKindSemantics:
		return "semantics"
	}
	return "unknown"
}

// apiHost is a fully-resolved API endpoint: a base URL and a kind that tells
// the dispatcher which request/response conventions to use.
type apiHost struct {
	BaseURL string
	Kind    apiKind
}

// Paths derived from the host kind. The vision-api and semantics-service
// each expose a /analyze, /jobs/{id}/status, and /jobs/{id}/results endpoint
// under their own namespace.
func (h *apiHost) analyzeURL() string {
	switch h.Kind {
	case apiKindRollup:
		return h.BaseURL + "/vision/analyze"
	case apiKindSemantics:
		return h.BaseURL + "/semantics/analyze"
	}
	return ""
}

func (h *apiHost) statusURL(jobID string) string {
	switch h.Kind {
	case apiKindRollup:
		return fmt.Sprintf("%s/vision/jobs/%s/status", h.BaseURL, jobID)
	case apiKindSemantics:
		return fmt.Sprintf("%s/semantics/jobs/%s/status", h.BaseURL, jobID)
	}
	return ""
}

func (h *apiHost) resultsURL(jobID string) string {
	switch h.Kind {
	case apiKindRollup:
		return fmt.Sprintf("%s/vision/jobs/%s/results", h.BaseURL, jobID)
	case apiKindSemantics:
		return fmt.Sprintf("%s/semantics/jobs/%s/results", h.BaseURL, jobID)
	}
	return ""
}

// -----------------------------------------------------------------------------
// API payload types (mirrors stash-auto-vision semantics-service models)
// -----------------------------------------------------------------------------

// SemanticsParameters carries ONLY classification configuration. Anything
// derived from the Stash scene (details, sprite URLs, captions, etc.) is
// deliberately omitted — the auto-vision service has its own Stash
// connection and will query everything it needs via source_id. The plugin
// only sends `source` (file path) and `source_id` as scene data in the
// outer request envelope.
type SemanticsParameters struct {
	ModelVariant                 string   `json:"model_variant,omitempty"`
	MinConfidence                *float64 `json:"min_confidence,omitempty"`
	TopKTags                     *int     `json:"top_k_tags,omitempty"`
	UseHierarchicalDecoding      *bool    `json:"use_hierarchical_decoding,omitempty"`
	FrameSelection               string   `json:"frame_selection,omitempty"`
	FramesPerScene               *int     `json:"frames_per_scene,omitempty"`
	SelectSharpest               *bool    `json:"select_sharpest,omitempty"`
	SharpnessCandidateMultiplier *int     `json:"sharpness_candidate_multiplier,omitempty"`
	MinFrameQuality              *float64 `json:"min_frame_quality,omitempty"`
	UseQuantization              *bool    `json:"use_quantization,omitempty"`
	GenerateEmbeddings           *bool    `json:"generate_embeddings,omitempty"`
}

// AnalyzeSemanticsRequest is the POST body for /semantics/analyze
// (apiKindSemantics). Parameters live at the top level alongside source.
type AnalyzeSemanticsRequest struct {
	Source     string              `json:"source"`
	SourceID   string              `json:"source_id"`
	Parameters SemanticsParameters `json:"parameters"`
}

// VisionAnalyzeRequest is the POST body for /vision/analyze (apiKindRollup).
// The rollup orchestrator runs scenes / faces / objects / semantics as
// independent modules, so parameters are nested under modules.semantics.
// The plugin only ever needs semantics, so the other modules are hard-disabled.
type VisionAnalyzeRequest struct {
	Source         string              `json:"source"`
	SourceID       string              `json:"source_id"`
	ProcessingMode string              `json:"processing_mode"`
	Modules        VisionModulesConfig `json:"modules"`
}

type VisionModulesConfig struct {
	Scenes    VisionModuleEnable    `json:"scenes"`
	Faces     VisionModuleEnable    `json:"faces"`
	Objects   VisionModuleEnable    `json:"objects"`
	Semantics VisionSemanticsModule `json:"semantics"`
}

type VisionModuleEnable struct {
	Enabled bool `json:"enabled"`
}

type VisionSemanticsModule struct {
	Enabled    bool                `json:"enabled"`
	Parameters SemanticsParameters `json:"parameters"`
}

// AnalyzeResponse is the shape both /semantics/analyze and /vision/analyze
// return on successful submit. Only the job_id field is load-bearing for
// the plugin.
type AnalyzeResponse struct {
	JobID     string `json:"job_id"`
	Status    string `json:"status"`
	Message   string `json:"message,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
	CacheHit  bool   `json:"cache_hit,omitempty"`
}

type JobStatusResponse struct {
	JobID          string  `json:"job_id"`
	Status         string  `json:"status"`
	Progress       float64 `json:"progress"`
	ProcessingMode string  `json:"processing_mode,omitempty"`
	Stage          string  `json:"stage,omitempty"`
	Message        string  `json:"message,omitempty"`
	CreatedAt      string  `json:"created_at,omitempty"`
	StartedAt      *string `json:"started_at,omitempty"`
	CompletedAt    *string `json:"completed_at,omitempty"`
	Error          *string `json:"error,omitempty"`
}

type ClassifierTag struct {
	TagID      string  `json:"tag_id"`
	TagName    string  `json:"tag_name"`
	Score      float64 `json:"score"`
	Path       string  `json:"path"`
	DecodeType string  `json:"decode_type"`
}

type SemanticsOutcome struct {
	Tags []ClassifierTag `json:"tags"`
}

// JobResultsResponse handles both the rollup (/vision/jobs/{id}/results) envelope
// and the namespaced (/semantics/jobs/{id}/results) envelope. Only the fields the
// plugin uses are deserialized; unknown keys are ignored.
type JobResultsResponse struct {
	JobID     string            `json:"job_id"`
	SourceID  string            `json:"source_id"`
	Status    string            `json:"status"`
	Semantics *SemanticsOutcome `json:"semantics"`
}

// -----------------------------------------------------------------------------
// Plugin state
// -----------------------------------------------------------------------------

type autoVisionPlugin struct {
	stopping         bool
	serverConnection common.StashServerConnection
	graphqlClient    *graphql.Client
	config           PluginConfig

	// Cache of tag descendants built lazily per task run so recursive exclusion
	// only walks the Stash tag tree once per ancestor.
	descendantCache map[string]map[string]bool
}

type PluginConfig map[string]interface{}

// Map is a GraphQL Map scalar alias used by runPluginTask(args_map: ...).
type Map map[string]interface{}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

func main() {
	if err := common.ServePlugin(&autoVisionPlugin{}); err != nil {
		panic(err)
	}
}

func (a *autoVisionPlugin) Stop(input struct{}, output *bool) error {
	log.Info("Stopping auto-vision-tagging plugin...")
	a.stopping = true
	*output = true
	return nil
}

func (a *autoVisionPlugin) Run(input common.PluginInput, output *common.PluginOutput) error {
	a.serverConnection = input.ServerConnection
	a.graphqlClient = util.NewClient(input.ServerConnection)
	a.descendantCache = map[string]map[string]bool{}

	cfg, err := a.getPluginConfiguration()
	if err != nil {
		errStr := fmt.Sprintf("failed to load plugin config: %v", err)
		*output = common.PluginOutput{Error: &errStr}
		return nil
	}
	a.config = cfg

	mode := input.Args.String("mode")
	var outputStr string
	var runErr error

	switch mode {
	case "tag":
		outputStr, runErr = a.tagScene(input)
	case "tagBatch":
		outputStr, runErr = a.tagBatch(input)
	case "tagOnCreate":
		outputStr, runErr = a.tagOnCreate(input)
	default:
		runErr = fmt.Errorf("unknown mode: %q", mode)
	}

	if runErr != nil {
		errStr := runErr.Error()
		log.Errorf("Run failed: %s", errStr)
		*output = common.PluginOutput{Error: &errStr}
		return nil
	}
	*output = common.PluginOutput{Output: &outputStr}
	return nil
}

// -----------------------------------------------------------------------------
// Mode: tag (single scene)
// -----------------------------------------------------------------------------

// tagScene submits one scene, polls the job to completion, applies exclusions,
// and writes the resulting tags back via sceneUpdate. The primary API host is
// tried first; on any failure the plugin falls over to the secondary host with
// its native request/response format.
//
// Required args from runPluginTask: mode=tag, scene_id. Optional: video_path
// (the JS layer sends it, but we re-query findScene for authoritative state).
func (a *autoVisionPlugin) tagScene(input common.PluginInput) (string, error) {
	sceneID := input.Args.String("scene_id")
	if sceneID == "" {
		return "", fmt.Errorf("scene_id is required")
	}

	primary, fallback, err := a.resolveAPIHosts()
	if err != nil {
		return "", err
	}

	scene, err := a.findScene(sceneID)
	if err != nil {
		return "", fmt.Errorf("findScene failed: %w", err)
	}
	if scene == nil {
		return "", fmt.Errorf("scene %s not found", sceneID)
	}
	if len(scene.Files) == 0 || scene.Files[0].Path == "" {
		return "", fmt.Errorf("scene %s has no video file", sceneID)
	}

	videoPath := scene.Files[0].Path
	params := a.buildSemanticsParameters(scene)

	log.Infof("Submitting scene %s (%s) via primary=%s", sceneID, videoPath, primary.Kind)

	jobID, activeHost, err := a.submitJobWithFallback(primary, fallback, sceneID, videoPath, params)
	if err != nil {
		return "", fmt.Errorf("submit failed: %w", err)
	}
	log.Infof("Job submitted: %s (via %s)", jobID, activeHost.Kind)

	// The host that accepted the submit is pinned for the remainder of the
	// task. Status and results both use activeHost's own URL template —
	// /vision/jobs/... for rollup, /semantics/jobs/... for semantics — so
	// the read path always matches the namespace the job was registered
	// under. No cross-host fallback for reads.
	statusResp, err := a.pollJobStatus(activeHost, jobID)
	if err != nil {
		return "", err
	}
	if statusResp.Status != "completed" {
		if statusResp.Error != nil {
			return "", fmt.Errorf("job ended with status=%s: %s", statusResp.Status, *statusResp.Error)
		}
		return "", fmt.Errorf("job ended with status=%s", statusResp.Status)
	}

	results, err := a.fetchResults(activeHost, jobID)
	if err != nil {
		return "", err
	}
	if results.Semantics == nil {
		return "", fmt.Errorf("completed job has no semantics payload")
	}
	log.Infof("Job %s returned %d tags", jobID, len(results.Semantics.Tags))

	applied, skipped, policy, err := a.applyTagsToScene(scene, results.Semantics.Tags)
	if err != nil {
		return "", err
	}

	// Emit a structured result line so the JS layer can pick it up via
	// pollLogsForMessage and render a final toast.
	resultJSON, _ := json.Marshal(map[string]interface{}{
		"success":  true,
		"scene_id": sceneID,
		"job_id":   jobID,
		"policy":   policy,
		"applied":  applied,
		"skipped":  skipped,
	})
	log.Infof("%s%s", logPrefixTagResult, string(resultJSON))

	// Cooldown: if this task was queued as part of a batch run (the
	// tagBatch enqueue loop sets from_batch="1" in the argsMap), sleep
	// before returning so the worker-queue slot stays held for the
	// configured interval. Stash serializes tasks on a single worker, so
	// holding the slot here is what actually creates a GPU-idle gap before
	// the next batch scene starts — sleeping in the tagBatch loop would
	// only delay queueing, not execution.
	//
	// Single-scene manual runs and the Scene.Create.Post hook do NOT set
	// from_batch, so they skip the cooldown entirely.
	if input.Args.String("from_batch") != "" {
		cooldownSeconds := getIntSetting(a.config, "cooldownSeconds", 5)
		if cooldownSeconds > 0 {
			log.Infof("Cooldown: sleeping %ds before releasing worker slot", cooldownSeconds)
			time.Sleep(time.Duration(cooldownSeconds) * time.Second)
		}
	}

	return fmt.Sprintf("scene %s tagged: %d applied, %d skipped (policy=%s)", sceneID, len(applied), skipped, policy), nil
}

// -----------------------------------------------------------------------------
// Mode: tagBatch
// -----------------------------------------------------------------------------

// tagBatch queues one Tag Scene task per eligible scene. Stash's worker queue
// serializes them, giving us one-at-a-time processing for free. Batch mode is
// a no-op unless autoTaggedTagId is set — without it we have no reliable way
// to know which scenes are already done.
func (a *autoVisionPlugin) tagBatch(input common.PluginInput) (string, error) {
	autoTaggedTagID := getStringSetting(a.config, "autoTaggedTagId", "")
	if autoTaggedTagID == "" {
		log.Info("Batch mode requires the Auto-tagged Tag ID setting to be configured — exiting without doing any work.")
		return "batch: no-op (autoTaggedTagId is not set)", nil
	}

	if _, _, err := a.resolveAPIHosts(); err != nil {
		return "", err
	}

	batchTagID := getStringSetting(a.config, "batchTagId", "")
	maxBatchSize := getIntSetting(a.config, "maxBatchSize", 50)
	cooldownSeconds := getIntSetting(a.config, "cooldownSeconds", 5)

	log.Infof("Starting batch: batchTagId=%q autoTaggedTagId=%s maxBatchSize=%d", batchTagID, autoTaggedTagID, maxBatchSize)

	scenes, err := a.findBatchScenes(batchTagID, autoTaggedTagID)
	if err != nil {
		return "", fmt.Errorf("failed to find batch scenes: %w", err)
	}
	log.Infof("Batch query returned %d scenes", len(scenes))

	// Defensive filter — the EXCLUDES branch of findBatchScenes already handles
	// this, but the INCLUDES-by-batchTagId branch may still match scenes that
	// happen to carry both the batch tag and the auto-tagged tag.
	eligible := make([]batchScene, 0, len(scenes))
	for _, s := range scenes {
		if sceneHasTag(s.Tags, autoTaggedTagID) {
			continue
		}
		if len(s.Files) == 0 || s.Files[0].Path == "" {
			log.Warnf("Skipping scene %s: no video file", string(s.ID))
			continue
		}
		eligible = append(eligible, s)
	}
	log.Infof("Eligible scenes after filtering: %d", len(eligible))

	if len(eligible) == 0 {
		return "batch: no eligible scenes", nil
	}

	if len(eligible) > maxBatchSize {
		log.Infof("Capping batch to maxBatchSize=%d (from %d eligible)", maxBatchSize, len(eligible))
		eligible = eligible[:maxBatchSize]
	}

	// Queue every eligible scene in one tight loop. Do NOT sleep here:
	// Stash's worker queue is serialized, so the batch task holds the
	// single worker slot for its entire lifetime and any tasks we queue
	// wait behind it until this batch task returns. A time.Sleep here
	// would only delay queueing, not actual scene processing. The real
	// cooldown lives at the end of tagScene, gated on the from_batch arg.
	queued := 0
	failed := 0
	for _, s := range eligible {
		if a.stopping {
			log.Info("Batch interrupted by Stop signal")
			break
		}
		if err := a.queueTagScene(string(s.ID), s.Files[0].Path, true); err != nil {
			log.Errorf("Failed to queue scene %s: %v", string(s.ID), err)
			failed++
			continue
		}
		queued++
	}

	return fmt.Sprintf("batch: queued %d, failed %d (cooldown=%ds runs per scene)", queued, failed, cooldownSeconds), nil
}

// -----------------------------------------------------------------------------
// Mode: tagOnCreate (hook)
// -----------------------------------------------------------------------------

// tagOnCreate is the Scene.Create.Post hook handler. It exits quickly unless
// the autoTagOnCreate setting is true and the scene is not already auto-tagged.
func (a *autoVisionPlugin) tagOnCreate(input common.PluginInput) (string, error) {
	if !getBoolSetting(a.config, "autoTagOnCreate", false) {
		return "hook: autoTagOnCreate disabled", nil
	}

	sceneID := extractHookSceneID(input.Args)
	if sceneID == "" {
		return "hook: missing scene id in hookContext", nil
	}

	autoTaggedTagID := getStringSetting(a.config, "autoTaggedTagId", "")
	if autoTaggedTagID != "" {
		scene, err := a.findScene(sceneID)
		if err != nil {
			log.Warnf("findScene failed in hook: %v — proceeding with queue", err)
		} else if scene != nil && sceneHasTag(scene.Tags, autoTaggedTagID) {
			return fmt.Sprintf("hook: scene %s already tagged", sceneID), nil
		}
	}

	if err := a.queueTagScene(sceneID, "", false); err != nil {
		return "", fmt.Errorf("hook: failed to queue Tag Scene task: %w", err)
	}
	return fmt.Sprintf("hook: queued Tag Scene for scene %s", sceneID), nil
}

// extractHookSceneID digs the scene ID out of the hookContext arg that Stash
// passes to hook invocations. Stash's common.HookContext has `ID int` but
// the value arrives in ArgsMap as a map[string]interface{} (json-decoded), so
// we handle multiple representations defensively.
func extractHookSceneID(args common.ArgsMap) string {
	raw, ok := args[common.HookContextKey]
	if !ok {
		return ""
	}
	m, ok := raw.(map[string]interface{})
	if !ok {
		return ""
	}
	id, ok := m["id"]
	if !ok {
		return ""
	}
	switch v := id.(type) {
	case string:
		return v
	case float64:
		return strconv.Itoa(int(v))
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	}
	return ""
}

// -----------------------------------------------------------------------------
// URL resolution
// -----------------------------------------------------------------------------

// resolveAPIHosts pulls the two required host settings plus the primary-API
// toggle and returns the primary + fallback as fully-typed apiHost pointers.
// Both hosts are mandatory — the plugin refuses to start work if either is
// missing, unparsable, or lacks an explicit port.
func (a *autoVisionPlugin) resolveAPIHosts() (*apiHost, *apiHost, error) {
	rollup := getStringSetting(a.config, "rollupApiUrl", "")
	semantics := getStringSetting(a.config, "semanticsApiUrl", "")

	if err := validateBaseURL("rollupApiUrl", rollup); err != nil {
		return nil, nil, err
	}
	if err := validateBaseURL("semanticsApiUrl", semantics); err != nil {
		return nil, nil, err
	}

	rollupHost := &apiHost{
		BaseURL: strings.TrimRight(rollup, "/"),
		Kind:    apiKindRollup,
	}
	semanticsHost := &apiHost{
		BaseURL: strings.TrimRight(semantics, "/"),
		Kind:    apiKindSemantics,
	}

	if getBoolSetting(a.config, "useSemanticsApiAsPrimary", false) {
		return semanticsHost, rollupHost, nil
	}
	return rollupHost, semanticsHost, nil
}

func validateBaseURL(name, raw string) error {
	if raw == "" {
		return fmt.Errorf("%s is required (set it in plugin settings)", name)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%s is not a valid URL: %w", name, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("%s must use http or https scheme (got %q)", name, u.Scheme)
	}
	if u.Hostname() == "" {
		return fmt.Errorf("%s must include a host", name)
	}
	if u.Port() == "" {
		return fmt.Errorf("%s must include an explicit port (e.g. %s://host:PORT)", name, u.Scheme)
	}
	return nil
}

// -----------------------------------------------------------------------------
// Submit
// -----------------------------------------------------------------------------

// buildSubmitBody packs the scene parameters into the shape the given host
// expects. Both shapes embed the same SemanticsParameters — only the outer
// wrapper differs.
func buildSubmitBody(host *apiHost, sceneID, videoPath string, params SemanticsParameters) (interface{}, error) {
	switch host.Kind {
	case apiKindSemantics:
		return AnalyzeSemanticsRequest{
			Source:     videoPath,
			SourceID:   sceneID,
			Parameters: params,
		}, nil
	case apiKindRollup:
		return VisionAnalyzeRequest{
			Source:         videoPath,
			SourceID:       sceneID,
			ProcessingMode: "sequential",
			Modules: VisionModulesConfig{
				Scenes:  VisionModuleEnable{Enabled: false},
				Faces:   VisionModuleEnable{Enabled: false},
				Objects: VisionModuleEnable{Enabled: false},
				Semantics: VisionSemanticsModule{
					Enabled:    true,
					Parameters: params,
				},
			},
		}, nil
	}
	return nil, fmt.Errorf("unknown apiKind %v", host.Kind)
}

// submitToHost performs a single POST against the given host's /analyze
// endpoint. Returns the parsed job_id.
func submitToHost(host *apiHost, sceneID, videoPath string, params SemanticsParameters) (string, error) {
	body, err := buildSubmitBody(host, sceneID, videoPath, params)
	if err != nil {
		return "", err
	}
	reqBody, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, host.analyzeURL(), bytes.NewBuffer(reqBody))
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: httpSubmitTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("http post: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var out AnalyzeResponse
	if err := json.Unmarshal(respBody, &out); err != nil {
		return "", fmt.Errorf("decode response: %w (body=%s)", err, string(respBody))
	}
	if out.JobID == "" {
		return "", fmt.Errorf("response missing job_id (body=%s)", string(respBody))
	}
	return out.JobID, nil
}

// submitJobWithFallback tries the primary host and, on any error, falls over
// to the fallback host with the fallback's native request shape. Returns the
// job_id along with the host that actually accepted the submission so
// subsequent reads can start there.
func (a *autoVisionPlugin) submitJobWithFallback(primary, fallback *apiHost, sceneID, videoPath string, params SemanticsParameters) (string, *apiHost, error) {
	jobID, err := submitToHost(primary, sceneID, videoPath, params)
	if err == nil {
		return jobID, primary, nil
	}
	log.Warnf("Primary submit to %s failed (%v) — falling over to %s", primary.Kind, err, fallback.Kind)
	log.Infof("%s", logPrefixFallbackSubmit)

	jobID, fbErr := submitToHost(fallback, sceneID, videoPath, params)
	if fbErr != nil {
		return "", nil, fmt.Errorf("primary submit failed (%v); fallback submit also failed: %w", err, fbErr)
	}
	return jobID, fallback, nil
}

// -----------------------------------------------------------------------------
// Status polling (single-host; no cross-host fallback)
// -----------------------------------------------------------------------------

// pollJobStatus polls `host`'s status endpoint until the job reaches a
// terminal state or jobTimeoutSeconds elapses. The URL path is derived from
// host.Kind — rollup hosts get /vision/jobs/{id}/status, semantics hosts get
// /semantics/jobs/{id}/status — so the namespace always matches the host the
// job was submitted to. Transient poll errors are logged and retried on the
// same host; there is no cross-host fallover.
func (a *autoVisionPlugin) pollJobStatus(host *apiHost, jobID string) (*JobStatusResponse, error) {
	pollInterval := getIntSetting(a.config, "pollIntervalSeconds", 2)
	if pollInterval < 1 {
		pollInterval = 1
	}
	jobTimeout := getIntSetting(a.config, "jobTimeoutSeconds", 1800)
	if jobTimeout < 1 {
		jobTimeout = 1800
	}

	ticker := time.NewTicker(time.Duration(pollInterval) * time.Second)
	defer ticker.Stop()

	deadline := time.Now().Add(time.Duration(jobTimeout) * time.Second)
	client := &http.Client{Timeout: httpStatusTimeout}
	endpoint := host.statusURL(jobID)

	for {
		if a.stopping {
			return nil, fmt.Errorf("task interrupted")
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("job %s timed out after %ds", jobID, jobTimeout)
		}

		status, err := fetchStatus(client, endpoint)
		if err != nil {
			log.Warnf("Status poll against %s failed: %v", endpoint, err)
			<-ticker.C
			continue
		}

		log.Progress(status.Progress)
		if status.Message != "" {
			log.Tracef("[%s] %s: %s", status.Status, status.Stage, status.Message)
		}

		switch status.Status {
		case "completed":
			return status, nil
		case "failed", "cancelled":
			return status, nil
		case "queued", "processing", "":
			// keep polling
		default:
			log.Warnf("Unknown job status %q, continuing to poll", status.Status)
		}

		<-ticker.C
	}
}

func fetchStatus(client *http.Client, endpoint string) (*JobStatusResponse, error) {
	resp, err := client.Get(endpoint)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}

	var out JobStatusResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode status: %w", err)
	}
	return &out, nil
}

// -----------------------------------------------------------------------------
// Results fetch (single-host; no cross-host fallback)
// -----------------------------------------------------------------------------

// fetchResults retrieves the job results from `host` using host.Kind to pick
// the right URL path. No cross-host fallover — the results endpoint is pinned
// to the same host that accepted the submit. If the response is missing or
// malformed, the task fails and the user retries.
//
// Both envelopes (rollup and semantics) expose `semantics.tags[]` at the same
// JSON path, so a single parser (JobResultsResponse) handles either shape.
func (a *autoVisionPlugin) fetchResults(host *apiHost, jobID string) (*JobResultsResponse, error) {
	client := &http.Client{Timeout: httpResultsTimeout}
	endpoint := host.resultsURL(jobID)

	results, err := fetchResultsAt(client, endpoint)
	if err != nil {
		return nil, fmt.Errorf("results fetch against %s failed: %w", endpoint, err)
	}
	if results.Semantics == nil {
		return nil, fmt.Errorf("results fetch against %s returned empty semantics payload", endpoint)
	}
	return results, nil
}

func fetchResultsAt(client *http.Client, endpoint string) (*JobResultsResponse, error) {
	resp, err := client.Get(endpoint)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}

	var out JobResultsResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode results: %w", err)
	}
	return &out, nil
}

// -----------------------------------------------------------------------------
// Parameter assembly
// -----------------------------------------------------------------------------

// buildSemanticsParameters constructs the parameters payload by overlaying
// plugin settings on the service-side defaults.
//
// Rules:
//   - Non-boolean settings: left blank → omit the field so the service's own
//     default applies.
//   - Boolean settings: every boolean in the manifest is an opt-out / opt-in
//     flag that defaults to OFF. OFF means "omit the field, take the service
//     default". ON means "explicitly send the non-default value". This is
//     forced by a Stash quirk where a boolean toggle that's never been touched
//     is indistinguishable in the UI from one that was explicitly set to false,
//     so the plugin cannot meaningfully default a boolean to true.
func (a *autoVisionPlugin) buildSemanticsParameters(scene *sceneInfo) SemanticsParameters {
	p := SemanticsParameters{}

	// Opt-in enum booleans: false (default) → omit the field so the service
	// applies its own default. true → explicitly send the alternative value.
	//
	// The plugin does not expose interval-based frame selection, so the only
	// two possible values for frame_selection are "sprite_sheet" (service
	// default, omitted) and "scene_based" (explicit opt-in).
	if getBoolSetting(a.config, "useVisionModel", false) {
		p.ModelVariant = "vision"
	}
	if getBoolSetting(a.config, "useSceneBasedFrameSelection", false) {
		p.FrameSelection = "scene_based"
	}

	if v, ok := getFloatSettingOpt(a.config, "minConfidence"); ok {
		p.MinConfidence = &v
	}
	if v, ok := getIntSettingOpt(a.config, "topKTags"); ok {
		p.TopKTags = &v
	}
	if v, ok := getIntSettingOpt(a.config, "framesPerScene"); ok {
		p.FramesPerScene = &v
	}
	if v, ok := getIntSettingOpt(a.config, "sharpnessCandidateMultiplier"); ok {
		p.SharpnessCandidateMultiplier = &v
	}
	if v, ok := getFloatSettingOpt(a.config, "minFrameQuality"); ok {
		p.MinFrameQuality = &v
	}

	// Opt-out booleans: flip only when the user explicitly turns them ON.
	if getBoolSetting(a.config, "disableHierarchicalDecoding", false) {
		f := false
		p.UseHierarchicalDecoding = &f
	}
	if getBoolSetting(a.config, "disableSharpestFrameSelection", false) {
		f := false
		p.SelectSharpest = &f
	}
	if getBoolSetting(a.config, "disableQuantization", false) {
		f := false
		p.UseQuantization = &f
	}

	// Opt-in booleans: send true only when the user turns them ON.
	if getBoolSetting(a.config, "generateEmbeddings", false) {
		t := true
		p.GenerateEmbeddings = &t
	}

	// Scene-derived fields (details, sprite URLs, captions, etc.) are
	// deliberately NOT forwarded. The auto-vision service has its own
	// Stash connection and will query whatever it needs from source_id.
	// The plugin only sends the outer source + source_id as scene data.
	_ = scene

	return p
}

// -----------------------------------------------------------------------------
// Tag application
// -----------------------------------------------------------------------------

// applyTagsToScene filters the classifier output through the exclusion lists,
// resolves the merge/replace policy, and writes the scene via sceneUpdate.
// Returns the IDs actually written, the number of classifier tags dropped by
// exclusions, and the effective policy string used (may be "merge" even when
// the user selected "replace" if the empty-list safety net kicked in).
func (a *autoVisionPlugin) applyTagsToScene(scene *sceneInfo, tags []ClassifierTag) ([]string, int, string, error) {
	autoTaggedTagID := getStringSetting(a.config, "autoTaggedTagId", "")

	excluded, err := a.buildExclusionSet()
	if err != nil {
		return nil, 0, "", fmt.Errorf("build exclusion set: %w", err)
	}

	keptIDs := make([]string, 0, len(tags))
	seen := map[string]bool{}
	skipped := 0
	for _, t := range tags {
		if t.TagID == "" {
			continue
		}
		if excluded[t.TagID] {
			skipped++
			continue
		}
		if seen[t.TagID] {
			continue
		}
		seen[t.TagID] = true
		keptIDs = append(keptIDs, t.TagID)
	}

	policy := "merge"
	if getBoolSetting(a.config, "replaceExistingTags", false) {
		policy = "replace"
	}

	// Safety net: replace + empty kept list silently degrades to merge for
	// this scene so we never wipe a scene's tags just because the classifier
	// returned nothing usable after exclusion.
	effectivePolicy := policy
	if policy == "replace" && len(keptIDs) == 0 {
		log.Warnf("Replace policy with empty post-exclusion tag list — falling back to merge for scene %s", string(scene.ID))
		effectivePolicy = "merge"
	}

	var finalIDs []string
	switch effectivePolicy {
	case "replace":
		// Replace wipes the scene's existing tags unconditionally, so the
		// exclusion set only needs to be consulted on the classifier side
		// (already done above when building keptIDs).
		finalIDs = append(finalIDs, keptIDs...)
		if autoTaggedTagID != "" && !containsString(finalIDs, autoTaggedTagID) {
			finalIDs = append(finalIDs, autoTaggedTagID)
		}
	default: // merge
		// Filter the scene's pre-existing tags through the exclusion set
		// too. Otherwise an excluded tag that was already on the scene —
		// from a prior plugin run, a manual add, or an earlier version
		// with different exclusion settings — would ride through the
		// merge untouched. The exclusion lists are meant to express "this
		// tag should never appear on the scene", not just "don't add this
		// tag from the classifier this one time".
		existing := make([]string, 0, len(scene.Tags))
		existingRemoved := 0
		for _, t := range scene.Tags {
			id := string(t.ID)
			if excluded[id] {
				existingRemoved++
				continue
			}
			existing = append(existing, id)
		}
		if existingRemoved > 0 {
			log.Infof("Exclusion: removed %d pre-existing tag(s) from scene %s that matched the exclusion set",
				existingRemoved, string(scene.ID))
		}
		finalIDs = mergeTagIDs(existing, keptIDs)
		if autoTaggedTagID != "" && !containsString(finalIDs, autoTaggedTagID) {
			finalIDs = append(finalIDs, autoTaggedTagID)
		}
	}

	if err := a.sceneUpdateTags(string(scene.ID), finalIDs); err != nil {
		return nil, 0, "", fmt.Errorf("sceneUpdate: %w", err)
	}

	return finalIDs, skipped, effectivePolicy, nil
}

// buildExclusionSet expands the recursive exclusion list into a flat set of
// tag IDs. The flat exclusion list is unioned in verbatim. The recursive
// entries are each walked via findTags(parents, depth=-1) and their entire
// descendant subtree is added. Results are cached per-task in
// a.descendantCache.
//
// Both lists are unioned together into a single exclusion set — they are
// additive, not alternatives.
func (a *autoVisionPlugin) buildExclusionSet() (map[string]bool, error) {
	excluded := map[string]bool{}

	flat := splitCSV(getStringSetting(a.config, "excludedTagIds", ""))
	for _, id := range flat {
		excluded[id] = true
	}

	recursive := splitCSV(getStringSetting(a.config, "excludedTagIdsRecursive", ""))

	log.Infof("Exclusion: flat=[%s] recursive=[%s]",
		strings.Join(flat, ","), strings.Join(recursive, ","))

	for _, parentID := range recursive {
		excluded[parentID] = true
		descendants, err := a.getDescendantsCached(parentID)
		if err != nil {
			return nil, fmt.Errorf("resolve descendants of %s: %w", parentID, err)
		}
		log.Infof("Exclusion: parent %s → %d descendants", parentID, len(descendants))
		for id := range descendants {
			excluded[id] = true
		}
	}

	log.Infof("Exclusion: total excluded tag IDs=%d", len(excluded))
	return excluded, nil
}

func (a *autoVisionPlugin) getDescendantsCached(parentID string) (map[string]bool, error) {
	if cached, ok := a.descendantCache[parentID]; ok {
		return cached, nil
	}
	descendants, err := a.findDescendantTags(parentID)
	if err != nil {
		return nil, err
	}
	a.descendantCache[parentID] = descendants
	return descendants, nil
}

// -----------------------------------------------------------------------------
// GraphQL: plugin configuration
// -----------------------------------------------------------------------------

type PluginsConfiguration struct {
	Plugins map[string]map[string]interface{} `json:"plugins"`
}

func (a *autoVisionPlugin) getPluginConfiguration() (PluginConfig, error) {
	ctx := context.Background()

	query := `query Configuration {
		configuration {
			plugins
		}
	}`

	data, err := a.graphqlClient.ExecRaw(ctx, query, nil)
	if err != nil {
		return nil, fmt.Errorf("query plugin configuration: %w", err)
	}

	var response struct {
		Configuration PluginsConfiguration `json:"configuration"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("unmarshal plugin configuration: %w", err)
	}

	if cfg, ok := response.Configuration.Plugins[PluginID]; ok {
		return cfg, nil
	}
	// No saved config yet — return empty so the user can start with service-side defaults.
	return PluginConfig{}, nil
}

// -----------------------------------------------------------------------------
// GraphQL: findScene
// -----------------------------------------------------------------------------

type sceneTag struct {
	ID   graphql.ID     `graphql:"id"`
	Name graphql.String `graphql:"name"`
}

type sceneFile struct {
	Path string `graphql:"path"`
}

// sceneInfo carries only the fields the plugin actually uses: the id (for
// sceneUpdate), the first file's path (for the submit request's `source`),
// and the tag list (for the already-tagged check and the merge policy).
// Anything else the service needs it queries from Stash itself.
type sceneInfo struct {
	ID    graphql.ID  `graphql:"id"`
	Files []sceneFile `graphql:"files"`
	Tags  []sceneTag  `graphql:"tags"`
}

func (a *autoVisionPlugin) findScene(sceneID string) (*sceneInfo, error) {
	ctx := context.Background()

	var query struct {
		FindScene *sceneInfo `graphql:"findScene(id: $id)"`
	}
	vars := map[string]interface{}{
		"id": graphql.ID(sceneID),
	}
	if err := a.graphqlClient.Query(ctx, &query, vars); err != nil {
		return nil, err
	}
	return query.FindScene, nil
}

// -----------------------------------------------------------------------------
// GraphQL: findScenes (batch)
// -----------------------------------------------------------------------------

type batchScene struct {
	ID    graphql.ID  `graphql:"id"`
	Title *string     `graphql:"title"`
	Files []sceneFile `graphql:"files"`
	Tags  []sceneTag  `graphql:"tags"`
}

type batchScenesResult struct {
	Count  graphql.Int
	Scenes []batchScene
}

type FindFilterType struct {
	PerPage *graphql.Int `json:"per_page"`
}

type HierarchicalMultiCriterionInput struct {
	Value    []graphql.String `json:"value"`
	Modifier graphql.String   `json:"modifier"`
	Depth    *graphql.Int     `json:"depth"`
}

type SceneFilterType struct {
	Tags *HierarchicalMultiCriterionInput `json:"tags"`
}

func (a *autoVisionPlugin) findBatchScenes(batchTagID, autoTaggedTagID string) ([]batchScene, error) {
	ctx := context.Background()

	var query struct {
		FindScenes batchScenesResult `graphql:"findScenes(filter: $f, scene_filter: $sf)"`
	}

	perPage := graphql.Int(5000)
	filterInput := &FindFilterType{PerPage: &perPage}

	depth := graphql.Int(-1)

	var sceneFilter *SceneFilterType
	if batchTagID != "" {
		sceneFilter = &SceneFilterType{
			Tags: &HierarchicalMultiCriterionInput{
				Value:    []graphql.String{graphql.String(batchTagID)},
				Modifier: "INCLUDES",
				Depth:    &depth,
			},
		}
	} else {
		sceneFilter = &SceneFilterType{
			Tags: &HierarchicalMultiCriterionInput{
				Value:    []graphql.String{graphql.String(autoTaggedTagID)},
				Modifier: "EXCLUDES",
				Depth:    &depth,
			},
		}
	}

	vars := map[string]interface{}{
		"f":  filterInput,
		"sf": sceneFilter,
	}
	if err := a.graphqlClient.Query(ctx, &query, vars); err != nil {
		return nil, err
	}
	return query.FindScenes.Scenes, nil
}

// -----------------------------------------------------------------------------
// GraphQL: findTags (for recursive descendant resolution)
// -----------------------------------------------------------------------------

// tagIDOnly is the minimal tag projection for recursive descendant lookups.
// It is a named type (rather than an inline anonymous struct) because
// hasura/go-graphql-client's reflection on anonymous element types inside
// slices is unreliable — the working batch query (batchScene / sceneFile)
// uses named element types for the same reason.
type tagIDOnly struct {
	ID graphql.ID `graphql:"id"`
}

type findTagsResult struct {
	Count graphql.Int `graphql:"count"`
	Tags  []tagIDOnly `graphql:"tags"`
}

type TagFilterType struct {
	Parents *HierarchicalMultiCriterionInput `json:"parents"`
}

// findDescendantTags returns every tag whose ancestry chain contains parentID.
// Uses depth=-1 so the whole subtree is pulled in one query.
//
// Notes on the variable shape — confirmed working against a live Stash
// instance via the GraphQL playground:
//
//   - per_page: -1 (unlimited) matches the playground behavior; a hardcoded
//     5000 cap silently loses tags on very large trees.
//   - modifier: INCLUDES_ALL, NOT INCLUDES. With depth=-1 the
//     hierarchicalCriterionHandler builds a recursive CTE and LEFT JOINs
//     it; the plain INCLUDES branch does not add the HAVING clause that
//     interacts correctly with the implicit grouping, and returns nothing
//     in practice. INCLUDES_ALL produces the correct behavior for a
//     single-value filter because len(Value)==1 makes the HAVING
//     trivially true.
func (a *autoVisionPlugin) findDescendantTags(parentID string) (map[string]bool, error) {
	ctx := context.Background()

	var query struct {
		FindTags findTagsResult `graphql:"findTags(filter: $f, tag_filter: $tf)"`
	}

	perPage := graphql.Int(-1)
	filter := &FindFilterType{PerPage: &perPage}

	depth := graphql.Int(-1)
	tf := &TagFilterType{
		Parents: &HierarchicalMultiCriterionInput{
			Value:    []graphql.String{graphql.String(parentID)},
			Modifier: "INCLUDES_ALL",
			Depth:    &depth,
		},
	}

	vars := map[string]interface{}{
		"f":  filter,
		"tf": tf,
	}
	if err := a.graphqlClient.Query(ctx, &query, vars); err != nil {
		return nil, fmt.Errorf("findTags: %w", err)
	}

	out := make(map[string]bool, len(query.FindTags.Tags))
	for _, t := range query.FindTags.Tags {
		out[string(t.ID)] = true
	}
	return out, nil
}

// -----------------------------------------------------------------------------
// GraphQL: sceneUpdate
// -----------------------------------------------------------------------------

func (a *autoVisionPlugin) sceneUpdateTags(sceneID string, tagIDs []string) error {
	// The Stash plugin util client has no HTTP timeout, so without a
	// context deadline the mutation could hang forever if the server
	// stalls. sceneUpdateTimeout bounds that at 30s.
	ctx, cancel := context.WithTimeout(context.Background(), sceneUpdateTimeout)
	defer cancel()

	var mutation struct {
		SceneUpdate struct {
			ID graphql.ID `graphql:"id"`
		} `graphql:"sceneUpdate(input: $input)"`
	}

	type SceneUpdateInput struct {
		ID     graphql.ID   `json:"id"`
		TagIDs []graphql.ID `json:"tag_ids"`
	}

	ids := make([]graphql.ID, 0, len(tagIDs))
	for _, id := range tagIDs {
		ids = append(ids, graphql.ID(id))
	}

	vars := map[string]interface{}{
		"input": SceneUpdateInput{
			ID:     graphql.ID(sceneID),
			TagIDs: ids,
		},
	}

	log.Infof("sceneUpdate: writing %d tag_ids to scene %s", len(ids), sceneID)
	if err := a.graphqlClient.Mutate(ctx, &mutation, vars); err != nil {
		return err
	}
	log.Infof("sceneUpdate: scene %s tags committed", sceneID)
	return nil
}

// -----------------------------------------------------------------------------
// GraphQL: runPluginTask (for batch + hook queueing)
// -----------------------------------------------------------------------------

// queueTagScene enqueues a Tag Scene task via runPluginTask. The fromBatch
// flag is forwarded as an arg so tagScene knows to apply the cooldown at the
// end of its run. Single-scene manual runs and hook invocations pass
// fromBatch=false; the batch enqueue loop passes true.
func (a *autoVisionPlugin) queueTagScene(sceneID, videoPath string, fromBatch bool) error {
	ctx := context.Background()

	var mutation struct {
		RunPluginTask graphql.ID `graphql:"runPluginTask(plugin_id: $pid, task_name: $tn, description: $desc, args_map: $am)"`
	}

	args := &Map{
		"mode":     "tag",
		"scene_id": sceneID,
	}
	if videoPath != "" {
		(*args)["video_path"] = videoPath
	}
	if fromBatch {
		(*args)["from_batch"] = "1"
	}

	desc := fmt.Sprintf("Auto-vision tagging scene %s", sceneID)
	vars := map[string]interface{}{
		"pid":  graphql.ID(PluginID),
		"tn":   graphql.String("Tag Scene"),
		"desc": graphql.String(desc),
		"am":   args,
	}
	return a.graphqlClient.Mutate(ctx, &mutation, vars)
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

func getStringSetting(cfg PluginConfig, key, def string) string {
	if v, ok := cfg[key]; ok {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return def
}

func getBoolSetting(cfg PluginConfig, key string, def bool) bool {
	if v, ok := getBoolSettingOpt(cfg, key); ok {
		return v
	}
	return def
}

func getBoolSettingOpt(cfg PluginConfig, key string) (bool, bool) {
	v, ok := cfg[key]
	if !ok {
		return false, false
	}
	switch x := v.(type) {
	case bool:
		return x, true
	case string:
		b, err := strconv.ParseBool(x)
		if err != nil {
			return false, false
		}
		return b, true
	}
	return false, false
}

func getIntSetting(cfg PluginConfig, key string, def int) int {
	if v, ok := getIntSettingOpt(cfg, key); ok {
		return v
	}
	return def
}

func getIntSettingOpt(cfg PluginConfig, key string) (int, bool) {
	v, ok := cfg[key]
	if !ok {
		return 0, false
	}
	switch x := v.(type) {
	case float64:
		return int(x), true
	case int:
		return x, true
	case string:
		if x == "" {
			return 0, false
		}
		i, err := strconv.Atoi(x)
		if err != nil {
			return 0, false
		}
		return i, true
	}
	return 0, false
}

func getFloatSettingOpt(cfg PluginConfig, key string) (float64, bool) {
	v, ok := cfg[key]
	if !ok {
		return 0, false
	}
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case string:
		if x == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(x, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func mergeTagIDs(existing, incoming []string) []string {
	seen := make(map[string]bool, len(existing)+len(incoming))
	out := make([]string, 0, len(existing)+len(incoming))
	for _, id := range existing {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	for _, id := range incoming {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

func containsString(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func sceneHasTag(tags []sceneTag, tagID string) bool {
	for _, t := range tags {
		if string(t.ID) == tagID {
			return true
		}
	}
	return false
}
