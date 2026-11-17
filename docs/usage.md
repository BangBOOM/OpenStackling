# Usage

See [Getting started](../README.md#getting-started) for installation and [Python Policy](../policy/README.md) for external models, configuration binding and LAN access. Run commands from the repository root.

For a browser installed outside the usual locations, set `STACKLING_CHROME` to its executable path.

## Articulated humanoid

The browser and CLI start with `configs/default.json` and the shared `configs/robot.json`: a fixed pedestal, motorized waist and two active arms. All six task presets use task-specific planners and the shared whole-body executor. The teacher chooses an arm and top, side or oblique approach based on reachability and clearance. It can move tower bases to improve subsequent work; partition tasks can use a real table placement for a bounded transfer between arms when direct placement is unreachable. Only one arm carries an object at a time. Settings → Joint state shows both arms and waist; keyboard Cartesian control still operates the negative-X arm.

The CLI uses the same default configuration.

```sh
bun run cli -- teacher --blocks 3 --seeds 0,2,42
bun run cli -- collect --blocks 3 --seeds 0,2,42 --out data/humanoid
bun run cli -- inspect data/humanoid
bun run cli -- replay data/humanoid/episodes/000000
```

Python policies use the `stackling.policy` WebSocket subprotocol and the same [16-value whole-body contract](../protocol/whole-body.md) as the teacher.

### Tune teacher preferences

`tune-teacher` runs deterministic parameter search over the whole-body teacher. It evaluates physical episodes, retains failed episodes, shortlists on training seeds, selects on validation seeds, then evaluates the selected policy once on disjoint test seeds. Reliability and maximum-height quality take priority over measured motion cost. It does not train a neural network or alter physics.

Create a plan with `cases` (each containing `name`, a humanoid `config`, and optional scene `generation`), disjoint nonempty `splits.train`, `splits.validation`, and `splits.test` seed arrays, `candidateCount` (1–17), `searchSeed`, `workers` (1–4), and an explicit `baseline`:

```json
{
  "waistTravel": 1.2,
  "waistReversal": 0.6,
  "waistPosture": 0.3,
  "armTravel": 0.2,
  "wristTravel": 0.12,
  "taskValue": 1,
  "topGrasp": 0.12,
  "sideGrasp": 0.04
}
```

```sh
bun run cli -- tune-teacher --plan teacher-plan.json --out data/teacher-search --workers 2
```

The output directory must be new. It contains the resolved plan, source identity, every candidate and episode result, measured motion metrics, selection evidence and `selected-policy.json`. Apply its `teacher.policy` configuration patch explicitly after reviewing the results. Test seeds must not be reused for further selection. Three candidates explore waist-travel preference first; seventeen cover both directions for all eight preferences. Candidate count and seed coverage determine the scope of evidence, not a guarantee of improvement. See [Architecture](architecture.md) for ownership and metrics and [Validation](validation.md) for recorded evidence.

## Scene controls

In **Settings → Scene**, **Scene Seed** is optional. Enter a seed for repeatable layouts, or clear it for a fresh random seed on each generation. **Apply & Reset** saves the rule and generates a scene; closing Settings cancels the draft. The toolbar's **Generate Scene** button applies the saved rule immediately, without opening a panel or starting execution. The actual scene seed is shown separately and recorded in episode metadata; generating a random seed never fills the optional input.

Generation is available while idle or after an episode ends, including with a bound external policy. Running, paused, connecting, review, binding, draining and fault states prevent regeneration. Failed generation preserves the previous scene and saved rule. Resetting or rerunning an episode continues to use its actual seed; only generation and applying settings select a new random seed.

**Settings** edits the selected task’s parameters, camera and environment while locally idle or finished. Parameter edits use preview, Apply and Cancel; Restore Defaults keeps the selected task family. With a bound policy between episodes, all six task presets, scene parameters, time limits and actual themes remain independently selectable. Parameter edits keep preview/Apply/Cancel and task-preserving Restore Defaults. Camera, physics and control/observation rates stay locked to the reviewed runtime contract. During execution and other connection states, all settings are read-only. Viewing settings does not pause or rebuild the episode. The Policy card's **View Configuration** opens the same Settings panel. Disconnecting restores local editing permissions.

With an external policy bound, the toolbar provides **Run / Pause / Resume / Run Again** and **Reset**. Pause first to reset an active task; Reset is also available after completion. It restores the current actual seed, preserves the connection, clears model history for the next episode and leaves execution idle. Reset is disabled during running, idle, cleanup and connection faults. The Policy card only manages connection and configuration; disconnecting restores the teacher controls.

## Camera views

**Settings → Camera → Main view** selects **Overview** or **First person**. The floating button at the top-right of the scene switches the same preference, including during execution. First person looks through the robot's central head lens; returning to Overview restores the previous orbit position. This display preference does not change policy observations or recordings. Closing an editable Settings draft restores its original view; Apply retains the selected view.

**Capture camera** separately selects **External camera** or **Head camera** for the RGB/depth preview, model input and recording. Head mode exposes lens pitch and vertical field of view instead of external position/distance/target controls. Defaults are 55° downward pitch and 70° vertical field of view, with a 0.02 m near plane. Resolution and depth capture are shared. Edits preview immediately and commit with **Apply & Reset**; Cancel restores the previous camera. Capture settings remain locked during execution or while bound to a policy. Main-view selection remains available.

To collect head-camera observations, pass `--config` with a JSON override:

```json
{
  "camera": {
    "mount": "head",
    "head": { "pitch": 55, "fov": 70, "near": 0.02 },
    "depth": true
  }
}
```

Head mode requires the humanoid mount. Pitch accepts 40–70° and vertical field of view 40–100°. Partial CLI configuration overrides inherit the default external camera; resolved configurations and Profiles must explicitly contain `camera.mount` and `camera.head`. `--positions` is external-camera-only and is rejected in head mode. The head housing follows the articulated torso in the whole-body environment; its lens pitch stays fixed relative to that housing. There is no independent gaze tracking. Recordings retain the actual optical calibration, and resume rejects a different camera configuration.

## Themes

The toolbar Theme selector switches **Island** and **Studio** immediately while idle or finished, including with a bound model. It changes background, lighting, decoration and environment/robot materials without resetting the physical world or moving the camera. Running, paused, editing and policy connection transitions lock the selector. Settings shows the current theme; Apply, Cancel and Restore Defaults preserve the theme selected in the toolbar. The selection lasts for the current session and is not stored in the browser.

Use `--theme island|studio` with `world`, `teacher`, `collect`, `policy` or `policy-profile`, or put `{"appearance":{"theme":"studio"}}` in a configuration file. The default is `island`; external-policy runs default to their Profile's training theme. Explicit CLI options override the configuration file. Each planned case has a fixed theme; resuming rejects a changed appearance plan. Replay uses its recorded theme and rejects appearance overrides; visual replay requires the recorded theme content to be installed.

Island retains its garden and trees, with continuous ground beneath the workbench. Studio contains the shared robot, workbench and task objects on a plain ground plane; no surrounding props are added. Laboratory is no longer an installed theme. Historical appearance metadata remains intact; a request to render the retired theme is rejected rather than silently substituting another theme.

For a manual cross-theme comparison, use the same seed list and separate directories:

```sh
bun run cli -- collect --policy ws://127.0.0.1:8000/policy --theme island --seeds 42,2026 --out data/eval-island
bun run cli -- collect --policy ws://127.0.0.1:8000/policy --theme studio --seeds 42,2026 --out data/eval-studio
```

Each run resets model history for every seed and preserves all task outcomes. The Policy card shows training/current themes and marks appearance evaluation automatically; the training Profile remains unchanged. Theme identifiers are not sent to model callbacks as features. This compares closed-loop behavior; replaying fixed actions only verifies physical isolation. There is no automatic paired-evaluation report or within-theme randomization in this version.

## Commands and configuration

```sh
# Record one teacher episode and serve it as the default replay policy demo
bun run cli -- policy-demo [--seed 42] [--out data/replay-demo] [--refresh] [--port 8000]

# Physics-only execution; no browser is launched
bun run cli -- teacher --seeds 42,2026
bun run cli -- teacher --blocks 5 --seeds 42,2026

# Interactive environment with explicit configuration
bun run cli -- world --camera N --width 640 --height 480

# Continuous random layouts, 10 Hz RGB, two collection workers
bun run cli -- collect --out data/demo --episodes 100 --workers 2

# Resume with identical parameters; completed episodes are not overwritten
bun run cli -- collect --out data/demo --episodes 100 --workers 2 --resume

# Change sampling rate and camera positions, and enable depth
bun run cli -- collect --out data/multiview --seeds 1,2,3,4 \
  --observation-hz 15 --control-hz 10 --positions N,NE,E,SE,S,SW,W,NW \
  --width 640 --height 480 --depth

bun run cli -- inspect data/demo
bun run cli -- replay data/demo/episodes/000000
bun run cli -- teacher --visual --seed 42 --out data/visible
bun run cli -- benchmark --out data/benchmark
bun run cli -- help
```

The CLI accepts `--config FILE`; the JSON file only needs the fields to override. Explicit CLI options take precedence. Physics, control and observation rates are independent, but both control and observation rates must divide the physics rate. Defaults are 120 Hz for physics, 20 Hz for control and 10 Hz for observations. `--height` specifies image height in pixels; `--camera-height` specifies metres above the tabletop.

Default layouts stay within a defined working region and reserve approach space using the open gripper envelope. Random collection does not select only seeds that succeed: failed tasks are saved, and fixed collection plans do not replace failed scenes. `configs/stress.json` covers the full table without reserving gripper clearance for diagnosing failures and crowded layouts.

Each episode uses a fixed camera. `--positions` selects one view from the supplied directions using an independent seed; it does not capture multiple views simultaneously. The main viewport and sensor camera are independent.

## Tasks and suites

Choose `--task-preset stack-all|partition-count|partition-color|stack-sized|stack-ordered|max-height`. The toolbar task selector next to Theme exposes the same six presets. Selecting one immediately creates an idle scene with that task’s default parameters; open Settings to edit its quantity, grouping, order and time limit. Switching is locked while running, paused or editing parameters, and command handlers enforce the same permissions. See [Architecture](architecture.md#multitask-contract) for rules and scoring.

```sh
bun run cli -- teacher --task-preset partition-count --seeds 0,1,2
bun run cli -- world --task-preset partition-color
bun run cli -- teacher --task-preset stack-ordered --seeds 42
bun run cli -- world --task-preset stack-sized --blocks 5 --seed 42
bun run cli -- world --task-preset max-height --blocks 8 --seed 2026
bun run cli -- collect --task-preset max-height --blocks 8 --out data/height --seeds 0,1,2
```

A configuration's `scene.objects` contains explicit IDs, cuboid/cylinder/sphere geometry, semantic colors, initial quaternion rotations, density and friction. `task` declares only the goal, prompt language and stability duration. Copy `configs/default.json` or `configs/five-blocks.json` when defining explicit inventories. `--blocks` sets the inventory count: different-size presets generate random cube sizes, and maximum height generates random shapes, dimensions and shape counts. With equal-size presets, or an explicit `--size`, it constructs equal cubes. Explicit CLI options override the configuration.

Settings exposes a count instead of a size list for different-size towers, and an object count for maximum height. Changing the scene seed or using Generate Scene regenerates these inventories. A fixed seed reproduces both geometry and placement; a blank seed generates a new scene. Generated geometry is saved as an explicit inventory.

Maximum-height CLI runs (`teacher`, `evaluate` and `collect`) automatically generate a new inventory from each episode's scene seed, without a task suite. `--blocks` fixes the total object count (default six); shapes, dimensions and category counts vary, and a category may be absent. Repeating a scene seed reproduces its inventory and layout, independently of worker assignment. The complete inventories and generation settings are fixed in `manifest.json` before workers start. Resume checks the same plan and preserves completed episodes:

```sh
bun run cli -- collect --task-preset max-height --blocks 8 --seconds 240 \
  --seed 0 --episodes 100 --out data/height-8
bun run cli -- collect --task-preset max-height --blocks 8 --seconds 240 \
  --seed 0 --episodes 100 --out data/height-8 --resume
```

This also applies to `collect --policy URL` and `evaluate --policy URL`. An explicit `scene.objects` list stays fixed unless overridden by `--blocks`; `--size` keeps equal cubes fixed, and explicit task suites retain their resolved inventories. Other task presets keep their resolved inventory across the episode seed plan.

The instruction is generated from the goal, displayed read-only, and saved verbatim. In the desktop UI, new local episodes follow the interface language without a separate instruction-language setting. Changing language leaves an active episode and its recorded prompt unchanged. Bound external policies receive the current episode instruction in the interface language; starting another episode supplies its current prompt without rewriting training metadata. CLI/configuration files can set `task.language` (`en` by default, or `zh`). Sorting supports both bottom-to-top directions; equal sizes are interchangeable. Height scores are metres above the tabletop and may include an unchanged initial object.

`--task-suite FILE` reads `{ "cases": [ ...configurationPatches ] }`. Each patch is resolved against the base configuration, followed by explicit CLI overrides. For example, the following uses the same default inventory with three different instructions:

```json
{
  "cases": [
    { "task": { "kind": "tower", "order": "any" } },
    { "task": { "kind": "partition-count", "counts": [1, 1] } },
    { "task": { "kind": "max-height" } }
  ]
}
```

```sh
bun run cli -- policy-profile --task-suite tasks.json --out profile.json
bun run cli -- collect --task-suite tasks.json --seeds 42,2026 --workers 2 --out data/multitask
bun run cli -- collect --task-suite tasks.json --seeds 42,2026 --workers 2 --out data/multitask --resume
# Evaluate a task independently of the service's training examples:
bun run cli -- policy --url ws://127.0.0.1:8000/policy --task-preset max-height --blocks 8 --seconds 240 --theme studio --seed 42 --out data/height-policy
# Or run an independent task/scene/theme suite through one policy connection:
bun run cli -- collect --policy ws://127.0.0.1:8000/policy --task-suite tasks.json --seeds 42,2026 --workers 1 --out data/model-evaluation
```

Collection plans the Cartesian product of cases and seeds before execution. Scene seeds may repeat; stable episode IDs identify entries. The manifest records the exact configuration, instruction and appearance for every entry. `summary.json.byCase` keeps episode IDs, seeds, outcomes and scores separate; different inventories are not ranked together. An external suite must match the service's shared runtime and I/O exactly; its tasks, inventories, time limits, seeds and themes can differ from training metadata. `policy-profile --task-suite` records the suite as immutable `trainingTasks` provenance, without creating an execution allowlist or establishing that an existing checkpoint was trained for it. Runtime configuration is adopted before external suite patches are resolved; explicit conflicting camera/physics/rate overrides are rejected. `--case-index` is removed.

Height episodes stop strategy decisions at the operation deadline and continue physical validation for one second by default. Their normal outcome is `completed`, including a zero-height score. Validation observations and system holds remain in the recording; exclude `label_valid == 0` rows from teacher supervision. Completion tasks instead require the entire stability window before their operation deadline. Dropped objects do not immediately end either task family.

## Result-only evaluation and reporting

`evaluate` executes the same resolved task and physical scheduler as `collect`, saving the immutable plan and terminal results without video or per-frame arrays. Without `--policy`, it evaluates the whole-body teacher in Node; `--visual` uses a browser. External policies still receive scheduled RGB and optional depth in a browser, with video encoding and recording uploads disabled. Evaluation currently requires one worker. `collect` and the existing `policy --url` command retain full recording. With an external policy, all three warn on stderr when the Profile was exported from another environment build; add `--strict-environment` to fail with a nonzero exit code instead, for example in acceptance runs that must execute the Profile's build.

```sh
bun run cli -- evaluate --task-preset max-height --blocks 8 --seed 0 --episodes 20 \
  --seconds 240 --out data/eval-teacher
bun run cli -- evaluate --policy ws://127.0.0.1:8000/policy \
  --task-preset max-height --blocks 8 --seed 0 --episodes 20 \
  --seconds 240 --out data/eval-policy
# Repeat the same evaluation command with --resume to continue.
bun run cli -- report data/eval-policy
bun run cli -- inspect data/eval-policy
```

Evaluation uses its own `kind: "evaluation"`, schemaVersion 2 manifest and `episodes/ID/result.json`; full recordings use dataset schema 10. Both formats preserve exact configurations, resolved initial poses, prompts, task outcomes, source/model/Profile/appearance identities and operation/check boundaries. Result-only episodes cannot be replayed because they have no action recording. Use `collect --policy URL` when video, actions, diagnostics or offline replay are needed.

`report RUN_DIRECTORY` reads either format without starting a browser or policy, changing files or executing physics. It includes committed episodes only, keeps failures in completion-rate denominators, and reports height count/minimum/maximum/mean/median from normal `completed` height episodes. Per-case rows retain seeds, episode IDs and individual scores; a zero height is a valid completed result. Corrupt or missing committed records fail the command. Use `inspect` to check full recording payloads as well as metadata. Reports and CLI result output use JSON on stdout; progress and diagnostics use stderr, so reports can be redirected to another file or consumed by another tool.

Resume rejects a changed complete plan, source/model identity, execution runtime or storage mode. It never converts evaluation results into recordings or overwrites completed failures. Incomplete episodes restart from their original plan, with partial artifacts retained under `interrupted/`. Default output is `data/evaluate-TIMESTAMP` when `--out` is omitted.

## Multi-GPU collection

Each collection worker owns a browser instance. On headless Linux with several NVIDIA GPUs (`/dev/nvidia0…N` present), every browser is pinned to one GPU by masking the other device nodes inside a private mount namespace, assigning GPUs round-robin; more workers than GPUs share them round-robin as well. Pinning requires root or unprivileged user namespaces; when neither is available, collection prints one warning and all browsers share GPU 0 as before. macOS and single-GPU systems never use device masking. Rendering (not the GPU) is rarely the limit: per-GPU utilization stayed below 12 percent at 96 workers on 8 GPUs, with CPU-side physics dominating. On one 8-GPU/192-core server, measured steady throughput was about 1 episode/s for one worker, near-linear to 16 workers, 45 episodes/s at 64 workers and no further gain at 96, where startup and browser reliability degrade; see the [archived validation evidence](validation.md#archived-evidence) for the historical sweep.

## Data and resuming collection

Each episode stores a lossy `video.mp4` (H.264, falling back to VP9 in browsers without H.264; yuv420; frame `i` is observation `i`; timestamps derive from the simulation clock; roughly 0.15 bit/px/frame with a 1-second keyframe interval, so random frame access stays cheap), a columnar `data.npz`, and `metadata.json` with the complete configuration, calibration, source hashes, result and file checksums plus the npz key table. Odd camera dimensions are even-cropped in the video only; depth keeps exact dimensions. State is measured; action is a target command. They are not interchangeable. Diagnostics contain ground truth and must not become standard model inputs. Metadata records the actual appearance identity alongside the complete configuration and provenance; a policy recording also retains its original training Profile.

Read an episode directly in Python:

```python
import numpy as np
z = np.load('data/demo/episodes/000000/data.npz')
states = z['obs.state']      # (N, 16) float64 measured states
actions = z['act.executed']  # (A, 16) float64 absolute targets
# video.mp4: decode with PyAV/decord/torchvision; frame i belongs to observation i
```

The [whole-body recording contract](../protocol/whole-body.md#dataset-schema-10) defines both TCPs, actuator references/velocities, effort estimates, finger contacts and object velocities in privileged diagnostics.

Metadata also contains resolved initial object poses, the exact task/prompt contract, teacher identity, final evaluation, and control/validation tick counts. `act.teacher_action` is aligned with all action rows when teacher labels exist; the mask distinguishes actual teacher targets from system holds.

The manifest requires a SHA-256 checksum for every indexed episode. Resume verifies these checksums and recovers a complete episode directory if the process exited between committing it and indexing it. On resume, interrupted temporary directories move to `interrupted/`, and those episodes restart from the beginning. Resuming rejects changed source code or configuration. Keep the source unchanged during collection.

For storage contracts and scheduling, see [Architecture](architecture.md).

## Runtime host and physics build

CLI commands use the Rust Rapier module built by `bun run build:physics`; `bun run cli` builds it before execution. Pure-state evaluation uses independent Bun worker threads without Chrome. Image collection and model evaluation use Chrome for Three.js sensor rendering while their physics and shared Runner remain in native host workers. Simulation/control/observation clocks keep their configured rates. Rebuild and restart the host after changing Rust.

Current recordings use schema 10 and environment `stackling-v5.4`. Native source, binary and toolchain identities participate in compatibility; preserve the original build and configuration when resuming or replaying. The [runtime contract](../protocol/runtime-host.md) describes the boundary.

Run `bun run check:architecture` to verify source boundaries and browser reachability. Build the Rust crate with `bun run build:physics` and run its independent suite with `bun run check:physics`.
