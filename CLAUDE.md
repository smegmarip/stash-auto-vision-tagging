# stash-auto-vision-tagging

A Stash plugin that submits scene classification jobs to the **stash-auto-vision** semantics service running on a remote NAS, polls each job to completion, and applies the resulting tags to scenes in Stash.

Replaces a partial Python prototype (`autovision.py` / `autovision.yml`) with a **hybrid Go RPC + JavaScript** plugin modelled on `stash-decensor`. The Python files have been removed — Stash scans every `.yml` in the plugin directory and the legacy manifest used the old list-style `settings:` schema that newer Stash versions reject, so keeping it around actively blocked plugin load.

---

## 1. High-level architecture 

```
+------------------+        runPluginTask        +-------------------+
|  Stash UI (JS)   |  ─────────────────────────► |  Stash Core       |
|  toolbar button  |                              |  plugin runner    |
+------------------+                              +-------------------+
        ▲                                                  │
        │ findJob (poll progress)                          │ exec
        │ pollLogsForMessage (final result)                ▼
        │                                         +-------------------+
        │                                         | Go RPC binary     |
        │                                         | gorpc/stash-...   |
        │                                         +-------------------+
        │                                                  │
        │                                  HTTP            │
        │                                                  ▼
        │                              +------------------------------------+
        │                              | stash-auto-vision                  |
        │                              |  semantics-service  (submit)       |
        │                              |  vision-api         (jobs)         |
        │                              +------------------------------------+
```

**Why hybrid (not pure Python):**
- Go RPC plugins run as a long-lived process per task and can poll a remote job to completion without re-launching the interpreter on every callback.
- JS gives us a per-scene toolbar button, progress indication, and a single "process selected" entry point that batches scenes one at a time and waits for each to finish — exactly the same UX as `stash-decensor`, which we're using as the structural template.
- A pure-Python plugin can't easily reach back into the UI for progress updates without spawning per-poll subprocesses.

**Reference implementation we're copying patterns from:** the `stash-decensor` Stash plugin (`stash-plugin/` directory of that repo).
- `gorpc/main.go` — RPC entry point, `Run(input, *output)` dispatch on a `mode` arg, `hasura/go-graphql-client` for Stash GraphQL calls, `runPluginTask` for queueing one-scene-at-a-time batch work.
- `js/stash-decensor.js` — toolbar button injection, `awaitJobFinished(jobId, onProgress)` polling `findJob`, `pollLogsForMessage(prefix)` for fetching structured results back from RPC logs.
- `js/stashFunctions.js` — small wrapper around the Stash GraphQL API.
- `stash-decensor.yml` — `interface: rpc`, `ui.javascript`, `ui.requires: CommunityScriptsUILibrary`, tasks with `defaultArgs.mode`.

---

## 2. Remote service contract

The plugin talks to **stash-auto-vision** via **two independent API hosts**, plus a `useSemanticsApiAsPrimary` boolean toggle that picks which one to try first.

**Two API host settings + primary toggle**, all configured independently. **There are no built-in URL defaults** — the scheme, host, *and port* for each endpoint are user-configurable, so the plugin must:

1. Treat each setting as a complete `scheme://host:port` base URL and use it verbatim — never strip the port, never substitute a hardcoded port, never assume two URLs share a port.
2. Surface a clear configuration error if any required URL is unset (or has no port).
3. Validate at startup that each URL parses cleanly and has a non-empty host *and* explicit port before submitting any work.

| Setting                     | Example                       | What it points at                                                                                             |
|-----------------------------|-------------------------------|---------------------------------------------------------------------------------------------------------------|
| `rollupApiUrl`              | `http://host:5010`            | Vision Roll-up API host. Serves `POST /vision/analyze` and `GET /vision/jobs/{id}/{status,results}`.          |
| `semanticsApiUrl`           | `http://host:5004`            | Semantics Service API host. Serves `POST /semantics/analyze` and `GET /semantics/jobs/{id}/{status,results}`. |
| `useSemanticsApiAsPrimary`  | `false` *(default)* / `true`  | BOOLEAN. false → rollup is primary, semantics is fallback. true → semantics is primary, rollup is fallback.   |

The two hosts share the same Redis-backed job store, so a job submitted via one host can be read via the other. **But the request bodies and response envelopes are host-specific** — the plugin keeps both shapes in its type model and picks the right one based on which host it's talking to at any given moment.

| Kind         | Submit                     | Status                                   | Results                                   |
|--------------|----------------------------|------------------------------------------|-------------------------------------------|
| `rollup`     | `POST /vision/analyze`     | `GET /vision/jobs/{id}/status`           | `GET /vision/jobs/{id}/results`           |
| `semantics`  | `POST /semantics/analyze`  | `GET /semantics/jobs/{id}/status`        | `GET /semantics/jobs/{id}/results`        |

The example column shows placeholder hosts — **they are not defaults**. Different deployments will use different hosts and ports. The stash-auto-vision repo also hosts its OpenAPI schema on a separate documentation port (something like `http://host:5009/openapi.yml|json|docs`); that's for reference only and not something the plugin calls.

### 2.0 Fallback semantics

The fallback is automatic, not manual. Each of the three operations (submit, status, results) has its own fallover logic:

1. **Submit.** Try the primary host with the primary's native request shape. On any error, retry once against the fallback host with the fallback's native shape and log `fallbackEngaged=submit`. The host that accepts the submission is **pinned** for the remainder of the task.
2. **Status polling.** Always hits the pinned host's own URL template (`/vision/jobs/{id}/status` for rollup, `/semantics/jobs/{id}/status` for semantics). Transient poll errors are logged and retried on the same host. There is **no cross-host fallover for reads** — a job registered in one host's namespace is not guaranteed to be visible through the other host's direct-read endpoint, so switching mid-poll previously produced spurious "Job not found" errors.
3. **Results fetch.** Same rule: always hits the pinned host's own URL template. If the response is non-2xx, unparsable, or has `semantics: null`, the task fails and the user retries.

Both result envelopes (rollup and semantics) expose `semantics.tags[]` at the same JSON path, so a single parser (`JobResultsResponse`) handles either shape:

| Field         | Rollup (`/vision/jobs/...`) | Semantics (`/semantics/jobs/...`) |
|---------------|-----------------------------|-----------------------------------|
| `job_id`      | yes                         | yes                               |
| `source_id`   | yes                         | yes                               |
| `status`      | yes                         | yes                               |
| `scenes`      | yes (nullable)              | absent                            |
| `faces`       | yes (nullable)              | absent                            |
| `objects`     | yes (nullable)              | absent                            |
| `semantics`   | yes (nullable)              | yes (always populated for completed jobs) |
| `metadata`    | yes                         | yes                               |

### 2.1 Submit

Two request shapes. **The embedded `SemanticsParameters` struct is identical in both** — only the outer wrapper differs:

**Semantics host (`POST {semanticsApiUrl}/semantics/analyze`):** parameters at the top level.
```json
{
  "source": "/data/library/scene.mp4",
  "source_id": "<scene-id>",
  "parameters": {
    "model_variant": "vision",
    "min_confidence": 0.75,
    "top_k_tags": 30,
    "frame_selection": "sprite_sheet"
  }
}
```

**Rollup host (`POST {rollupApiUrl}/vision/analyze`):** parameters nested under `modules.semantics.parameters`. The plugin always hard-disables scenes/faces/objects because it only cares about tag classification.
```json
{
  "source": "/data/library/scene.mp4",
  "source_id": "<scene-id>",
  "processing_mode": "sequential",
  "modules": {
    "scenes":   {"enabled": false},
    "faces":    {"enabled": false},
    "objects":  {"enabled": false},
    "semantics": {
      "enabled": true,
      "parameters": { "model_variant": "vision", "min_confidence": 0.75, "top_k_tags": 30, "frame_selection": "sprite_sheet" }
    }
  }
}
```

Both endpoints return HTTP 200/202 with the same `AnalyzeResponse` shape:
```json
{ "job_id": "uuid", "status": "queued", "created_at": "...", "cache_hit": false }
```

The authoritative schema lives in the stash-auto-vision repo: `openapi.yml` at the repo root, Pydantic source under `semantics-service/app/models.py`.

### 2.2 Status

Live response shape (the deployed `JobStatusResponse` includes a few more fields than `AnalyzeJobStatus` in the openapi.yml):
```json
{
  "job_id": "<job-uuid>",
  "status": "completed",
  "progress": 1.0,
  "processing_mode": "sequential",
  "stage": "completed",
  "message": "Analysis complete in 293.9s (N tags)",
  "services": [],
  "created_at": "...",
  "started_at": "...",
  "completed_at": null,
  "result_summary": null,
  "error": null
}
```

The plugin polls this on a fixed cadence (default **2s**, like `stash-decensor`'s `pollJobStatus`) and forwards `progress` to Stash via `log.Progress(...)` so the JS layer can display it on the toolbar button. Terminal states are `completed` and `failed`. The `message` field carries human-readable summaries that the JS layer can pipe into a final toast (e.g. `"Analysis complete in 293.9s (N tags)"`). The `services` array can be empty for a single-service semantics job — don't depend on it for progress aggregation.

### 2.3 Results

Two envelopes. Both expose `semantics.tags[]` at the same JSON path, so one parser handles both.

**Rollup envelope (`GET {rollupApiUrl}/vision/jobs/{id}/results`).** Includes top-level `scenes` / `faces` / `objects` keys which are null when the corresponding module did not run:
```json
{
  "job_id": "<job-uuid>",
  "source_id": "<scene-id>",
  "status": "completed",
  "scenes": null,
  "faces": null,
  "objects": null,
  "semantics": {
    "tags": [
      { "tag_id": "<stash-tag-id>", "tag_name": "<name>", "score": 0.97, "path": "Semantics > ...", "decode_type": "competition" },
      { "tag_id": "<stash-tag-id>", "tag_name": "<name>", "score": 0.96, "path": "Semantics > ...", "decode_type": "direct" }
      /* ...additional ClassifierTag entries... */
    ],
    "frame_captions": [ /* ignored */ ],
    "scene_summary": "...",
    "scene_embedding": null
  },
  "metadata": {
    "source": "/data/library/scene.mp4",
    "source_id": "<scene-id>",
    "classifier_model": "vision",
    "tag_name_to_id": { /* ~N entries */ },
    "scene": { "title": "...", "duration": 0.0, "resolution": "..." }
  }
}
```

**Semantics envelope (`GET {semanticsApiUrl}/semantics/jobs/{id}/results`).** Same top-level `job_id` / `source_id` / `status` / `semantics` / `metadata`, but the rollup-only `scenes`, `faces`, `objects` keys are absent:
```json
{
  "job_id": "<job-uuid>",
  "source_id": "<scene-id>",
  "status": "completed",
  "semantics": {
    "tags": [
      { "tag_id": "<stash-tag-id>", "tag_name": "<name>", "score": 0.96, "path": "...", "decode_type": "competition" }
      /* ...additional ClassifierTag entries... */
    ],
    "frame_captions": [ /* ignored */ ],
    "scene_summary": "...",
    "scene_embedding": null
  },
  "metadata": { "source_id": "<scene-id>", "classifier_model": "vision", "tag_name_to_id": { /* ~N entries */ }, "scene": { "title": "...", "duration": 0.0 } }
}
```

**Important:**
- `semantics.tags[].tag_id` is already a string-form **Stash tag ID** — no client-side resolution is needed. The plugin only needs `tag_id`; `score`, `path`, and `decode_type` are useful for logging but not required.
- `frame_captions`, `scene_summary`, `scene_embedding`, and `metadata` are ignored by the current scope (tags-only side-effects, see §4).
- `decode_type` of `"competition"` or `"direct"` indicates how a tag was selected during hierarchical decoding. The plugin treats both equivalently — they're already past the `min_confidence` threshold by the time the service returns them.
- The `semantics` field is `null` if the underlying job did not run the semantics module. The plugin should treat that as a hard failure (no tags to apply).

---

## 3. Plugin manifest (auto-vision-tagging.yml)

```yaml
name: Auto Vision Tagging
description: Submit scenes to the auto-vision semantics service and apply the resulting tags
version: 0.1.0

ui:
  requires:
    - CommunityScriptsUILibrary
  javascript:
    - https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js
    - js/stashFunctions.js
    - js/auto-vision-tagging.js

exec:
  - gorpc/stash-auto-vision-tagging-rpc
interface: rpc

tasks:
  - name: Tag Scene
    description: Run auto-vision classification on a single scene
    defaultArgs:
      mode: tag
  - name: Batch Tag Scenes
    description: Run auto-vision classification on every eligible scene, one at a time
    defaultArgs:
      mode: tagBatch

hooks:
  - name: Auto-tag on scan
    description: Submit newly created scenes to auto-vision (gated by autoTagOnCreate setting)
    triggeredBy:
      - Scene.Create.Post
    defaultArgs:
      mode: tagOnCreate

settings:
  # --- API hosts (no defaults — user must configure for their deployment) ---
  rollupApiUrl:              { displayName: Vision Roll-up API Host,    type: STRING,  description: "Base URL of the vision-api orchestrator (scheme + host + explicit port). Serves POST /vision/analyze and GET /vision/jobs/{id}/status|results. Required." }
  semanticsApiUrl:           { displayName: Semantics Service API Host, type: STRING,  description: "Base URL of the semantics-service (scheme + host + explicit port). Serves POST /semantics/analyze and GET /semantics/jobs/{id}/status|results. Required." }
  useSemanticsApiAsPrimary:  { displayName: Use Semantics API as Primary, type: BOOLEAN, description: "OFF (default) → rollup is primary, semantics is fallback. ON → semantics is primary, rollup is fallback." }
  pollIntervalSeconds:       { displayName: Poll Interval (s),          type: NUMBER,  description: "Integer seconds. Default: 2" }
  jobTimeoutSeconds:         { displayName: Job Timeout (s),            type: NUMBER,  description: "Integer seconds. Default: 1800" }

  # --- Default classification parameters (floats as STRING because Stash NUMBER is integer-only) ---
  useVisionModel:                { displayName: Use Vision Model,                  type: BOOLEAN, description: "OFF → service default (model_variant=text-only). ON → explicitly send model_variant=vision." }
  minConfidence:                 { displayName: Minimum Confidence,                type: STRING,  description: "Decimal string 0.0–1.0 (e.g. 0.75). Blank → service default (0.75)." }
  topKTags:                      { displayName: Top K Tags,                        type: NUMBER,  description: "1–100. Blank → service default (30)." }
  useSceneBasedFrameSelection:   { displayName: Use Scene-based Frame Selection,   type: BOOLEAN, description: "OFF → service default (frame_selection=sprite_sheet). ON → explicitly send frame_selection=scene_based. Interval mode is not supported." }
  framesPerScene:                { displayName: Frames Per Scene,                  type: NUMBER,  description: "1–32. Blank → service default (16)." }
  sharpnessCandidateMultiplier:  { displayName: Sharpness Candidate Multiplier,    type: NUMBER,  description: "1–10. Blank → service default (3)." }
  minFrameQuality:               { displayName: Min Frame Quality,                 type: STRING,  description: "Decimal string 0.0–1.0 (e.g. 0.05). Blank → service default." }

  # --- Opt-out / opt-in flags (every BOOLEAN defaults to false, see §3.1) ---
  disableHierarchicalDecoding:   { displayName: Disable Hierarchical Decoding,    type: BOOLEAN, description: "OFF → service applies its default (hierarchical decoding ON). ON → explicitly disable." }
  disableSharpestFrameSelection: { displayName: Disable Sharpest Frame Selection, type: BOOLEAN, description: "OFF → service default (sharpness filter ON). ON → explicitly disable." }
  disableQuantization:           { displayName: Disable 4-bit Quantization,       type: BOOLEAN, description: "OFF → service default (quantization ON). ON → explicitly disable." }
  generateEmbeddings:            { displayName: Generate Embeddings,              type: BOOLEAN, description: "OFF → service default (no embeddings). ON → request embeddings. Plugin ignores the output either way." }

  # --- Tag application policy ---
  autoTaggedTagId:               { displayName: Auto-tagged Tag ID,           type: STRING,  description: "Optional for single-scene mode; REQUIRED for batch mode. Used as the 'already classified' marker." }
  excludedTagIds:                { displayName: Excluded Tag IDs,             type: STRING,  description: "Comma-separated Stash tag IDs to drop from results (selective)." }
  excludedTagIdsRecursive:       { displayName: Recursively Excluded Tag IDs, type: STRING,  description: "Comma-separated Stash tag IDs whose entire descendant subtree should be dropped." }
  replaceExistingTags:           { displayName: Replace Existing Tags,        type: BOOLEAN, description: "OFF (default) → merge: new tags are unioned with existing. ON → replace: existing tags are DISCARDED before applying new ones (destructive)." }
  mergeSummaryWhenMissing:       { displayName: Merge Summary When Details Empty, type: BOOLEAN, description: "OFF (default) → plugin never touches the scene's details field. ON → when the scene has no existing details AND the classifier returned a scene_summary, write the summary into details alongside the tag update. Never overwrites non-empty details." }
  mergeTitleWhenMissing:         { displayName: Merge Title When Scene Title Empty, type: BOOLEAN, description: "OFF (default) → plugin never touches the scene's title field. ON → when the scene has no existing title AND the classifier returned a suggested_title, write that title into the scene alongside the tag update. Never overwrites non-empty titles." }

  # --- Batch / hook ---
  batchTagId:                   { displayName: Batch Input Tag ID,           type: STRING,  description: "Optional. Batch mode filters by this tag (descendants included) when set." }
  maxBatchSize:                 { displayName: Max Batch Size,               type: NUMBER,  description: "Default: 50" }
  cooldownSeconds:              { displayName: Cooldown Between Scenes (s),  type: NUMBER,  description: "Default: 5" }
  autoTagOnCreate:              { displayName: Auto-tag New Scenes,          type: BOOLEAN, description: "OFF (default) → Scene.Create.Post is a no-op. ON → hook queues a Tag Scene task per new scene." }
```

> The table above is shorthand for readability; the real `auto-vision-tagging.yml` uses the canonical array shape (each setting as its own block with `displayName` / `description` / `type`).

### 3.1 Stash setting-type constraints (important)

Stash's plugin settings system imposes two constraints that shape the manifest above:

1. **`NUMBER` is integer-only.** Any parameter whose natural representation is a float (`minConfidence`, `minFrameQuality`) is declared as **`STRING`** and the Go layer parses it via `strconv.ParseFloat`. The setting descriptions call this out so users know to enter decimal strings like `0.75`.
2. **`BOOLEAN` settings must default to `false`.** A toggle that has never been touched is indistinguishable in the UI from one that was explicitly set to false, so if the plugin defaulted a boolean to `true`, users would have no way to tell "still on the default" from "I disabled this". Every boolean in the manifest is therefore a **false-by-default opt-out or opt-in flag**. This constraint also forces small-enumeration STRING settings to become binary booleans — any "pick one of N" setting has to be expressed as an opt-in for the non-default value. The manifest is structured accordingly:
    - **Opt-out flags (service feature is on by default, user turns it off):** `disableHierarchicalDecoding`, `disableSharpestFrameSelection`, `disableQuantization`. OFF → omit the field, service applies its own default (on). ON → plugin sends the explicit non-default value to turn the feature off.
    - **Opt-in flags (user opts into a non-default behavior):** `generateEmbeddings`, `autoTagOnCreate`, `useSemanticsApiAsPrimary`, `useVisionModel`, `useSceneBasedFrameSelection`, `replaceExistingTags`, `mergeSummaryWhenMissing`, `mergeTitleWhenMissing`. OFF matches the service / plugin default (or the "don't touch it" posture for scene state). ON makes the plugin send the explicit opt-in value (`vision`, `scene_based`, etc.), switch the internal default (replace policy, semantics-as-primary), or enable one of the scene-mutation side-effects (details or title write when the corresponding scene field is empty).

As a result there are no `useHierarchicalDecoding`, `selectSharpest`, `useQuantization`, `modelVariant`, `frameSelection`, `primaryApi`, or `updatePolicy` settings — each would need either a true-by-default boolean or a small-enum STRING, neither of which the Stash UI can represent unambiguously. Sprite URL forwarding is also omitted: the auto-vision service resolves sprite sheets itself from `source_id`, so the plugin does not need to expose a setting for it. Interval-based frame selection is likewise omitted (the plugin only supports `sprite_sheet` and `scene_based`), so there is no `samplingIntervalSeconds` setting.

---

## 4. Behaviors

### 4.1 Single-scene flow ("Tag Scene" task)

Triggered by the toolbar button in JS or by a manual task run with `mode=tag`.

JS layer (`js/auto-vision-tagging.js`):
1. Read scene from Stash via `findScene` (id, title, files[0].path, paths.{sprite,vtt}, tags{id}).
2. `runPluginTask("Tag Scene", argsMap = { mode, scene_id, video_path, sprite_vtt, sprite_image, existing_tag_ids, ...settings})`.
3. `awaitJobFinished(jobId, onProgress)` polling `findJob` on a 500 ms cadence; pipe progress into the toolbar button overlay.
4. After RPC job finishes, `pollLogsForMessage("[Plugin / Auto Vision Tagging] tagResult=")` to read the structured outcome.
5. Refresh Apollo cache and toast a result.

Go RPC layer (`gorpc/main.go`, mode `tag`):
1. Validate args and settings; require `rollupApiUrl` and `semanticsApiUrl` to parse cleanly with explicit ports. `resolveAPIHosts()` reads the `useSemanticsApiAsPrimary` boolean to pick which host is primary and returns `primary, fallback *apiHost` — both typed with their API kind so the dispatcher can build the right path and body.
2. Submit. Try the primary host's `/analyze` endpoint with its native request shape (`AnalyzeSemanticsRequest` for semantics, `VisionAnalyzeRequest` for rollup). On any error, fall over to the fallback host with the fallback's shape and log `fallbackEngaged=submit`. The host that accepts the submission becomes the starting point for reads.
3. Poll status on the pinned host (the one that accepted the submit). URL path comes from the pinned host's own template — `/vision/jobs/{id}/status` for rollup, `/semantics/jobs/{id}/status` for semantics — so the namespace always matches. Transient poll errors are logged and retried on the same host. Surface progress via `log.Progress(...)`. Bail on `failed`/`cancelled` or after `jobTimeoutSeconds`. **No cross-host fallover for reads.**
4. On `completed`, fetch results from the pinned host using the same template (`/vision/jobs/{id}/results` or `/semantics/jobs/{id}/results`). If the response is non-2xx, unparsable, or has `semantics: null`, the task fails and the user retries.
5. Read `semantics.tags[]` from whichever response succeeded.
6. Apply exclusions (see §4.3) and resolve the final tag list.
7. Update the scene via the GraphQL `sceneUpdate` mutation:
    - **Merge** policy (default): union of existing tag IDs + new IDs + optional `autoTaggedTagId`.
    - **Replace** policy: discard existing tags entirely, write only new IDs (+ `autoTaggedTagId` if set). Existing tags are not preserved — this is intentional, document it loudly in the setting description.
8. Emit a `tagResult={…}` log line for the JS layer.
9. **Cooldown tail.** If `input.Args.String("from_batch") != ""` (set by `tagBatch` when enqueueing), sleep for `cooldownSeconds` before returning. The sleep runs on the Stash worker slot the task is currently holding, so it creates a real gap before the next batch scene starts. Single-scene manual runs and hook-triggered runs do NOT set `from_batch` and skip the cooldown entirely — no trailing wait after a manual toolbar click.

**Side-effects scope:** the plugin writes the `tag_ids` field on every run. It **conditionally** writes the `details` field when all three of these are true: (a) the `mergeSummaryWhenMissing` setting is ON, (b) the scene's existing `details` field is empty or whitespace, and (c) the classifier returned a non-empty `scene_summary`. Symmetrically, it **conditionally** writes the `title` field when `mergeTitleWhenMissing` is ON, the scene's existing `title` is empty, and the classifier returned a non-empty `suggested_title`. Scenes that already have any details / title content are never overwritten. `frame_captions`, `scene_embedding`, and the rest of the results `metadata` are discarded.

**Reprocess behavior:** the single-scene flow (toolbar button, Tag Scene task) always reprocesses, even if the scene already carries `autoTaggedTagId`. This is intentional — invoking the action manually is treated as an explicit user request to reclassify (e.g. after a model update or a parameter change). Batch mode still skips already-tagged scenes (see §4.2).

**Reading `title` / `details`:** the plugin queries `scene.title` and `scene.details` from Stash via `findScene` purely so the `mergeTitleWhenMissing` and `mergeSummaryWhenMissing` features can tell whether the corresponding field already has content. These values are **not** forwarded into the classification request — the auto-vision service has its own Stash connection and resolves any scene metadata it needs from `source_id` on its own. The plugin never mutates `scene.title` or `scene.details` unless the corresponding feature is explicitly enabled AND the existing value is empty.

### 4.2 Batch flow ("Batch Tag Scenes" task)

Mode `tagBatch`. One-scene-at-a-time, mirroring `stash-decensor`'s `decensorBatch`:

1. Load plugin config; resolve `batchTagId`, `autoTaggedTagId`, `maxBatchSize`.
2. **Require `autoTaggedTagId` to be set.** If it is empty, log an info-level message ("Batch mode requires the Auto-tagged Tag ID setting to be configured — exiting without doing any work.") and return success. The batch flow has no other reliable way to know which scenes are already done, so without that marker it would either reprocess every scene on every run or have to keep state somewhere else. Single-scene mode is unaffected and still works without `autoTaggedTagId` (it always reprocesses).
3. Find candidate scenes:
    - **If `batchTagId` is set:** `findScenes(scene_filter: { tags: { value: [batchTagId], modifier: INCLUDES, depth: -1 } })`.
    - **If `batchTagId` is empty:** `findScenes(scene_filter: { tags: { value: [autoTaggedTagId], modifier: EXCLUDES, depth: -1 } })`.
4. Filter out any remaining scenes that already carry `autoTaggedTagId` (defensive — the GraphQL EXCLUDES filter should already handle this, but the include-by-batchTagId path might still match already-tagged scenes).
5. Cap to `maxBatchSize`.
6. For each remaining scene, `runPluginTask("Tag Scene", argsMap)` to enqueue a single-scene job. The argsMap includes a `from_batch: "1"` marker so the downstream `tagScene` run knows this scene was queued from batch mode. Stash's worker queue serializes these so we get one-at-a-time processing for free.
7. **Do not sleep in the batch enqueue loop.** The batch task itself occupies Stash's single worker slot for its entire lifetime, so sleeping between enqueues only delays *queueing*, not actual scene processing — all the per-scene Tag Scene tasks we enqueued are waiting behind the batch task in the worker queue and cannot run until the batch task returns. The real cooldown lives at the end of `tagScene` (§4.1).

The batch task itself returns once all scenes are queued; individual progress lives in the per-scene job status.

### 4.3 Tag exclusion logic

Two settings:

| Setting                    | Behavior                                                                                                                                                                |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `excludedTagIds`           | Comma-separated tag IDs. Drop any returned tag whose `tag_id` matches one of these IDs verbatim.                                                                        |
| `excludedTagIdsRecursive`  | Comma-separated tag IDs. Drop any returned tag whose `tag_id` matches one of these IDs **or is a descendant** of one of them in the Stash tag hierarchy.                |

Resolving descendants:
- The Go RPC layer caches a tag→descendants map per task run (queried lazily) by walking `findTags(tag_filter: { parents: { value: [parentId], modifier: INCLUDES, depth: -1 } })`. We do **not** persist this cache between RPC invocations because each RPC invocation is a fresh subprocess.
- Build the union of all IDs to drop, then filter the classifier `tags` slice in one pass.
- The exclusion list is empty by default — if both settings are blank, every returned tag is applied.

### 4.4 Auto-tag-on-create hook

Mode `tagOnCreate`. Bound to `Scene.Create.Post`. Reads the scene ID from `args.hookContext.id`. If `autoTagOnCreate=false`, immediately exit. Otherwise, check whether the scene already carries `autoTaggedTagId` (via `findScene`); if it does, exit silently (the hook is reactive, not a manual reclassify). Otherwise, enqueue a `Tag Scene` task via `runPluginTask` so the work goes through the worker queue rather than blocking the hook execution path. This preserves the existing `autovision.py` behavior while staying out of the way of scenes that have already been processed.

### 4.5 Failure handling

| Failure mode                                              | Behavior                                                                                                                                                                                       |
|-----------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Required URL setting unset or unparsable                  | Refuse to start the task. Return a configuration error with the offending setting name.                                                                                                       |
| **Primary** submit non-2xx or network error               | Retry once against the fallback host with its native request shape. Log `fallbackEngaged=submit`. Whichever host accepts the submit becomes the pinned host for all subsequent reads.         |
| **Fallback** submit non-2xx or network error              | Hard failure — return a "primary failed + fallback failed" error to Stash. The user can rerun the task.                                                                                       |
| Status poll against pinned host non-2xx or unparsable     | Log warning, sleep one extra tick, continue polling on the same host. No cross-host fallover.                                                                                                 |
| `status=failed` or `status=cancelled`                     | Log the `error` field from the status response, return failure.                                                                                                                                 |
| Status poll exceeds `jobTimeoutSeconds`                   | Return timeout error. Do **not** attempt to cancel the remote job — the service has its own queue.                                                                                             |
| Results fetch non-2xx, unparsable, or `semantics: null`   | Hard failure — log the error, return failure, do not touch the scene. The read endpoint is pinned to the submit host and is not retried against the opposite host.                            |
| `sceneUpdate` mutation fails                              | Log the GraphQL error, return failure. No partial writes — the mutation either applies all tag IDs or none.                                                                                    |
| Empty tag list after exclusion                            | Treat as success (still apply `autoTaggedTagId` if set under merge policy). Do **not** wipe existing tags under replace policy in this case — fall back to merge to avoid data loss.           |
| Plugin process killed (Stop RPC call)                     | Set the `stopping` flag (à la `stash-decensor`) and break out of the polling loop with a "task interrupted" error.                                                                            |

---

## 5. Repo layout (target)

```
stash-auto-vision-tagging/
├── CLAUDE.md                         ← this file
├── auto-vision-tagging.yml           ← Stash plugin manifest
├── gorpc/
│   ├── go.mod
│   ├── go.sum
│   ├── main.go                       ← RPC entry, dispatch, all HTTP calls + GraphQL
│   └── stash-auto-vision-tagging-rpc ← built binary committed alongside source (matches stash-decensor convention)
├── js/
│   ├── stashFunctions.js             ← thin Stash GraphQL helpers (cribbed from stash-decensor)
│   └── auto-vision-tagging.js        ← toolbar button, progress UI, log polling
└── (legacy autovision.py / autovision.yml were removed — see §1)
```

`go.mod` requirements (mirrors stash-decensor):
- `github.com/stashapp/stash` (for `pkg/plugin/common`, `pkg/plugin/common/log`, `pkg/plugin/util`)
- `github.com/hasura/go-graphql-client`

**Build target:** the committed `gorpc/stash-auto-vision-tagging-rpc` binary is built for **`linux/amd64` only**. Stash typically runs in a Linux x86_64 docker container and loads this binary by the path in `exec:`. Use a make target / shell script along the lines of:

```sh
cd gorpc && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o stash-auto-vision-tagging-rpc ./...
```

If the deployment target ever changes (ARM NAS, native macOS, etc.), add the additional `GOOS`/`GOARCH` combos to the build script and ship per-platform binaries — but until that's a real requirement, do not pre-build for platforms we don't need.

The legacy `autovision.py` and `autovision.yml` files were removed from the plugin directory because Stash refused to load the plugin set while the old manifest was still present — Stash's current YAML loader expects `settings:` to be a map keyed by setting name, and the old Python manifest used the list form. Git history still has both files if anyone needs to look at the old behavior.

---

## 6. Resolved decisions

- Plugin id is `auto-vision-tagging`.
- Replace + empty post-exclusion list silently falls back to merge for that scene.
- Single-scene mode always reprocesses; batch mode skips already-tagged scenes; the hook also skips already-tagged scenes.
- Batch mode requires `autoTaggedTagId` to be set — without it, batch gracefully exits with an info log and no work done. Update policy is irrelevant to this rule.
- `details` is forwarded from Stash when non-empty, otherwise omitted.
- Build target is linux/amd64 only.
- **Sprite URLs do not need authentication from the plugin side.** The auto-vision service manages its own access to the Stash API, so `sprite_vtt_url` / `sprite_image_url` can be forwarded as the plain paths returned by `findScene`'s `paths.vtt` / `paths.sprite` fields. No API key appending, no session cookie forwarding.
