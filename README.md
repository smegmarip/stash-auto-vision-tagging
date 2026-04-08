# Auto Vision Tagging

A [Stash](https://github.com/stashapp/stash) plugin that submits scene classification jobs to a remote **stash-auto-vision** deployment, polls each job to completion, and applies the resulting tags back to the scene.

Hybrid **Go RPC + JavaScript** plugin, structurally modelled on `stash-decensor`. A long-lived Go RPC process handles HTTP dispatch to the auto-vision service, job polling, tag exclusion, and Stash GraphQL mutations; a small JS layer injects a per-scene toolbar button and displays live progress.

## Features

- **Per-scene toolbar button** — click the tag icon on any scene page to classify that scene. A progress overlay tracks the running job and a toast reports the result.
- **Batch mode** — queues every eligible scene for classification, one at a time, through Stash's worker queue. A configurable cooldown runs between scenes to throttle the GPU.
- **Scene.Create.Post hook** — optionally auto-tags newly scanned scenes, skipping scenes that are already marked as classified.
- **Dual-host routing** — supports two independent auto-vision API hosts (Vision Rollup and Semantics Service) with automatic submit-time fallover. The host that accepts the submit is pinned for all subsequent status and results reads.
- **Flat + recursive tag exclusion** — drop unwanted classifier tags by ID, or by an ancestor whose entire subtree should be excluded. Exclusion applies to both the classifier's output _and_ any matching tags already on the scene, so a scene is always left in a state consistent with the current exclusion list.
- **Merge or replace update policy** — default merge preserves existing scene tags and unions the classifier output on top; replace (opt-in) wipes the scene's existing tags first.
- **Optional scene summary fill-in** — opt-in setting that writes the classifier's generated `scene_summary` into the scene's `details` field, but only for scenes whose `details` field is currently empty. Scenes that already have a description are never overwritten.

## Architecture

```
+------------------+      runPluginTask       +-------------------+
|  Stash UI (JS)   |  ──────────────────────► |  Stash Core       |
|  toolbar button  |                          |  plugin runner    |
+------------------+                          +-------------------+
        ▲                                              │
        │ findJob (poll progress)                      │ exec
        │ pollLogsForMessage (tagResult=…)             ▼
        │                                     +-------------------+
        │                                     | Go RPC binary     |
        │                                     | gorpc/stash-…-rpc |
        │                                     +-------------------+
        │                                              │
        │                                   HTTP       │
        │                                              ▼
        │                         +--------------------------------------+
        │                         | stash-auto-vision                    |
        │                         |   vision-api  (rollup host)          |
        │                         |   semantics-service  (semantics host)|
        │                         +--------------------------------------+
```

A detailed design spec — settings, behaviors, failure modes, fallback semantics, GraphQL shape constraints — lives in [`CLAUDE.md`](CLAUDE.md).

## Prerequisites

1. **Stash** 0.29.x or newer, with plugin support enabled.
2. A reachable **stash-auto-vision** deployment. You'll need two base URLs:
   - The **Vision Roll-up API host**, e.g. `http://host:5010`
   - The **Semantics Service API host**, e.g. `http://host:5004`
3. The **CommunityScriptsUILibrary** Stash plugin (declared as a `ui.requires` dependency in the manifest).

## Installation

1. Clone this repository into your Stash `plugins` directory:

   ```sh
   cd <your-stash-plugin-dir>
   git clone https://github.com/<your-org>/stash-auto-vision-tagging.git
   ```

   (A common plugins directory is `~/.stash/plugins/` on Linux or `%APPDATA%/stash/plugins/` on Windows — whatever your Stash installation is configured to use.)

2. In Stash, open **Settings → Plugins** and click **Reload plugins**. "Auto Vision Tagging" should appear in the plugin list.

3. Open the plugin's settings panel and configure at minimum:
   - **Vision Roll-up API Host** — e.g. `http://host:5010`
   - **Semantics Service API Host** — e.g. `http://host:5004`
   - **Auto-tagged Tag ID** — optional for single-scene mode, **required for batch mode**. This is a Stash tag ID that the plugin adds to every scene it processes, so it can tell which scenes are already done.

4. Optionally tune classification parameters, exclusion lists, batch size, cooldown interval, and the merge/replace policy to taste.

The plugin ships with a precompiled `gorpc/stash-auto-vision-tagging-rpc` binary built for `linux/amd64`, which is what most Stash deployments run (Linux containers). If you need a different platform, see the build instructions below.

## Usage

### Single-scene classification

Open any scene in Stash and click the tag icon in the scene toolbar. The button shows a live progress percentage while the job runs. When it finishes, a toast reports how many tags were applied.

You can also run **Settings → Tasks → Auto Vision Tagging → Tag Scene** if you prefer the task panel.

Single-scene runs **always reprocess** — even if the scene already carries the auto-tagged marker — because manually invoking the action is treated as an explicit user request to reclassify (e.g. after a model update or a parameter change).

### Batch classification

Run **Settings → Tasks → Auto Vision Tagging → Batch Tag Scenes**. The plugin:

1. Finds candidate scenes:
   - If **Batch Input Tag ID** is set, every scene that carries that tag (descendants included).
   - Otherwise, every scene that does not yet carry the **Auto-tagged Tag ID**.
2. Defensively filters out any scene that already has the auto-tagged marker.
3. Caps the remaining list to **Max Batch Size**.
4. Enqueues each scene as an individual **Tag Scene** task through Stash's worker queue. Stash serializes tasks on a single worker, so classification runs one scene at a time.
5. Each per-scene task applies the **Cooldown Between Scenes** delay before releasing its worker slot, creating a real GPU-idle gap between consecutive scenes.

**Batch mode requires `Auto-tagged Tag ID` to be set.** Without that marker there's no reliable way to know which scenes are already done — the plugin logs an info message and exits without doing any work.

### Auto-tag on scan (hook)

Toggle **Auto-tag New Scenes** on in the plugin settings. The `Scene.Create.Post` hook then queues a **Tag Scene** task for every newly created scene, silently skipping scenes that already carry the auto-tagged marker.

## Settings at a glance

The plugin manifest (`auto-vision-tagging.yml`) and the plugin's Settings panel in Stash are the authoritative sources. A few things to know:

- **Two hosts are required.** There are no built-in defaults — configure both URL settings with a full `scheme://host:port`.
- **`Use Semantics API as Primary`** — OFF (default) uses the rollup host first; ON flips the order. The other host is the automatic submit-time fallback.
- **Float-valued settings use STRING type.** Stash's `NUMBER` type is integer-only, so `Minimum Confidence` and `Minimum Frame Quality` are declared as STRING — enter decimal strings like `0.75`.
- **Boolean settings default to `false`.** A Stash boolean toggle that has never been touched is indistinguishable in the UI from one explicitly set to false, so every boolean in the manifest is an explicit opt-in or opt-out of the non-default behavior. Setting names like `disableHierarchicalDecoding` (opt-out) and `useVisionModel` / `replaceExistingTags` (opt-in) make the direction explicit.
- **Interval-based frame selection is not supported.** Only `sprite_sheet` (default) and `scene_based` are exposed.
- **`Merge Summary When Details Empty`** (opt-in) — when ON, the plugin will write the classifier's `scene_summary` into the scene's `details` field on the same `sceneUpdate` call that writes tags, but only for scenes whose `details` field is currently empty or whitespace. Non-empty details are always preserved. When OFF (default), the plugin never touches the `details` field.

## Building from source

A linux/amd64 build is shipped in `gorpc/`. To rebuild it (or cross-compile to another platform), you need **Go 1.24.3 or newer**.

```sh
cd gorpc
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w" \
  -o stash-auto-vision-tagging-rpc ./...
chmod +x stash-auto-vision-tagging-rpc
```

The `chmod +x` step is not optional — Stash silently fails to load an RPC plugin whose binary lacks the executable bit. If you change `GOOS`/`GOARCH`, make sure the filename in `auto-vision-tagging.yml`'s `exec:` block still matches what Stash expects to find.

## Structured log prefixes

The Go RPC binary emits a few structured log lines that the JS layer consumes and that make debugging easier:

| Prefix                                                                   | Meaning                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tagResult={…}`                                                          | Per-scene JSON outcome — scene_id, job_id, policy, list of applied tag ids, count of excluded tags.                                                                                         |
| `fallbackEngaged=submit`                                                 | The primary submit host failed and the plugin successfully fell over to the fallback host. All subsequent reads for this task use the fallback host.                                        |
| `Exclusion: flat=[…] recursive=[…]`                                      | The exclusion settings as read at the start of the task. Useful to confirm the plugin actually saw the IDs you configured.                                                                  |
| `Exclusion: parent <id> → N descendants`                                 | For each `excludedTagIdsRecursive` entry, the number of descendant tags found via Stash's tag hierarchy.                                                                                    |
| `Exclusion: total excluded tag IDs=N`                                    | Size of the merged exclusion set that will be applied to both the classifier output and the scene's pre-existing tags.                                                                      |
| `Exclusion: removed K pre-existing tag(s) from scene X`                  | Pre-existing scene tags that matched the exclusion set and were evicted during a merge-policy update. Only fires when K > 0.                                                                |
| `Scene X has empty details — writing classifier scene_summary (N chars)` | The `Merge Summary When Details Empty` feature fired for this scene. Only emitted when the setting is ON, the scene's `details` was empty, and the classifier produced a non-empty summary. |
| `sceneUpdate: writing N tag_ids to scene X`                              | About to call Stash's `sceneUpdate` mutation. Appends ` + M-char details` when a summary write is bundled into the same mutation.                                                           |
| `sceneUpdate: scene X committed`                                         | The mutation returned without error. If you see the "writing" line but not the "committed" line, the mutation hung or errored.                                                              |
| `Cooldown: sleeping Ns before releasing worker slot`                     | Batch-queued scene is holding its worker slot for the configured cooldown so the next batch scene doesn't start immediately. Only emitted when the task was queued from batch mode.         |

## Repository layout

```
stash-auto-vision-tagging/
├── README.md                             ← this file
├── CLAUDE.md                             ← full project spec / design doc
├── auto-vision-tagging.yml               ← Stash plugin manifest
├── gorpc/
│   ├── go.mod / go.sum
│   ├── main.go                           ← RPC entry, HTTP + GraphQL
│   └── stash-auto-vision-tagging-rpc     ← committed linux/amd64 build
└── js/
    ├── stashFunctions.js                 ← thin Stash GraphQL helpers
    └── auto-vision-tagging.js            ← toolbar button, progress UI, log polling
```

## Credits

- Structural template and GraphQL helper patterns adapted from **stash-decensor**.
- Classification backend: **stash-auto-vision**.
