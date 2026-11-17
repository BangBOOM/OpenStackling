# External Policy

An independent Python 3.12 project managed with uv. FastAPI handles the protocol and sessions; users supply a model through a factory function. No training framework, checkpoint format, history window or directory layout is prescribed. TypeScript retains ownership of physics, synchronized sampling, scoring and collection timing.

## Run the replay demo

From the repository root:

```sh
uv sync --project policy --locked
bun run cli -- policy-demo
```

`policy-demo` records one teacher episode with seed 42 into `data/replay-demo`, exports the profile from the current source, and serves `stackling_policy.examples.replay:create` on `ws://127.0.0.1:8000/policy`. The recording is reused when present; pass `--refresh` to record again, `--out` chooses the location and `--port` forwards to the server. Recording and profile always share one build, and the model revision is derived from the recorded actions. Export the profile again after environment code changes. The UI and profile must use the same build. Restart a development server that was running before a code update to refresh its environment fingerprint.

In the UI, apply the Profile, set Scene Seed to `42` in Settings, click **Apply & Reset**, and click **Run**. Other seeds are allowed and may fail to stack. Alternatively, run `collect --policy ws://127.0.0.1:8000/policy --out data/replay-result --seeds 42` through the CLI.

In the UI, open **External Policy** in the upper-right corner, enter the address and optional token, connect, review the configuration differences, and click **Apply & Bind**. Binding does not start an episode. **Run** starts the policy and then becomes Pause/Resume. The fixed-width toolbar button reads **Run Again** after completion. **Reset** is available only while paused or after completion: it cancels pending actions, waits for episode cleanup and restores the same actual scene seed without disconnecting or starting execution. It is disabled while running, idle, transitioning or faulted. The Policy card manages the connection and configuration; it has no separate Stop button. Teacher controls and speed selection are hidden during a policy connection and return after disconnecting. Once bound, Settings displays the applied configuration. Binding preserves the selected task, scene, seed rule and theme while applying the reviewed runtime contract. The toolbar task selector offers all six presets between episodes. Settings edits task quantity, grouping/order, time limit and scene seed through preview/Apply/Cancel; camera, physics and control/observation rates remain locked. Restore Defaults preserves the selected task and bound runtime. Use **View Configuration** in the Policy card to open it. In Settings, apply a seed for repeatable generation or clear it for random generation. **Apply & Reset** saves that rule and generates a scene. The toolbar's **Generate Scene** button then regenerates directly using the saved rule. The actual generated seed is shown separately and never fills the optional input. Running and paused episodes cannot regenerate their scene. A connection fault leaves configuration locked until explicit disconnection, which restores local controls while retaining the applied configuration.

For result-only CLI benchmarks, use `evaluate --policy ws://HOST:PORT/policy`; use `collect --policy` for complete recordings. Both supply the same current prompt and sensor/action contract. See [evaluation and reporting](../docs/usage.md#result-only-evaluation-and-reporting) for commands, artifacts and resume rules.

## Appearance evaluation

The service uses `stackling.policy`. Its Profile records immutable core configuration and `trainingAppearance`; trainingTasks records training examples without limiting evaluation. Actual scene, task, prompt, seeds and theme identity are supplied and hashed at each episode start; configure binds only runtime and calibration. Between episodes, use the toolbar Theme selector or CLI `--theme island` / `--theme studio`. Core configuration and calibration remain strict. The Policy card displays the training and current theme and marks a mismatch as appearance evaluation, including a changed theme version or content hash.

Model callbacks receive shared runtime configuration and a prompt-only TaskContext, as defined in the protocol. Theme IDs and appearance metadata are not additional model features. Reset still clears model history before each episode. Compare the same declared seeds using separate datasets; see [Usage](../docs/usage.md#themes). The replay demo consumes images but does not predict from them, so its success across themes does not demonstrate visual generalization.

Cached demo recordings from another build or configuration are rejected; use a new output directory, or `--refresh` when intentionally replacing the demo. Do not regenerate a Profile from current defaults to claim that unrelated old weights are compatible.

## Manual recording and serving

`policy-demo` is equivalent to recording and serving by hand:

```sh
bun run cli -- collect --config configs/default.json --out data/replay-demo --seeds 42
bun run cli -- inspect data/replay-demo
bun run cli -- policy-profile --config configs/default.json --out data/replay-demo/profile.json
STACKLING_REPLAY_EPISODE=data/replay-demo/episodes/000000 \
  uv run --project policy stackling-policy serve \
  --profile data/replay-demo/profile.json \
  --factory stackling_policy.examples.replay:create \
  --policy-id replay-demo --model-revision replay-demo-v1
```

Check that the recorded teacher episode succeeded before using it as a successful demonstration. Use a new output directory for another recording and update the model revision when changing the recording. The example reads the existing episode format; generated frames and actions stay outside Git.

The service decodes every live frame. The demo computes RGB means and a rolling RGB/depth digest, logging frame counts and the final digest. Actions are recorded absolute joint targets selected by control tick, not predictions from images. After the recording ends, it holds the last target until the independent scorer ends the episode. Configuration mismatch, corrupted action data and invalid control timing are rejected. No teacher runs inside the Python service, and no block poses are changed directly.

## Custom models

Provide an importable `module:factory`. The factory takes no arguments, loads resources once at startup, and returns an implementation of this interface:

```python
from stackling_policy.interfaces import (
    EpisodeContext,
    Observation,
    ActionTarget,
    ControlContext,
    EpisodeSummary,
)


class MyPolicy:
    def __init__(self, model):
        self.model = model
        self.history = []

    def reset(self, context: EpisodeContext) -> None:
        self.history.clear()
        self.instruction = context.task.prompt
        self.model.reset(context.config)

    def observe(self, observation: Observation) -> None:
        # Choose history length and preprocessing inside your implementation.
        self.history.append(observation)

    def act(self, context: ControlContext) -> ActionTarget:
        # Return waist, both arms and both gaps in the absolute Action16D ordering.
        targets = self.model.predict(
            self.history, context.dt, self.instruction
        ).tolist()
        return ActionTarget(targets)

    def end(self, summary: EpisodeSummary) -> None:
        self.history.clear()


def create():
    from my_model import load_model

    return MyPolicy(load_model())
```

Install model dependencies with `uv add --project policy ...`, or point `PYTHONPATH` to your code:

```sh
PYTHONPATH=/path/to/my/code uv run --project policy stackling-policy serve \
  --profile data/profile.json --factory my_adapter:create \
  --policy-id my-policy --model-revision checkpoint-001
```

Custom factories require an explicit policy ID and immutable model revision. Change the revision when updating weights; resuming collection rejects a changed model identity. Images are NumPy RGB `uint8[H,W,3]`; optional depth is `uint16[H,W]` in millimetres, with 0 indicating an invalid value. State16D contains measured waist yaw/pitch, both arms and both gaps. `Observation.camera_to_world` is the exact float64 4×4 sensor pose at the observation tick, including head/waist motion. `act` returns `ActionTarget(action=[16 absolute targets], continuous=False)`; set `continuous=True` for sampled continuous trajectories. Both modes enforce the same absolute limits. Models receive no structured goal, task-case identity, scene inventory, object ground truth or teacher objects. `context.task` contains only prompt text, language and the operation time budget. The current episode prompt comes from the runtime request rather than Profile training examples. Training coverage does not imply measured generalization; evaluate outcomes for each task and appearance. See the protocol for per-episode descriptors. An implementation may manage an asynchronous inference framework internally, but these four callbacks are synchronous and the service invokes them serially.

## LAN access

Set the same `STACKLING_POLICY_TOKEN` environment variable on the server and CLI client. For the UI, enter the token in the floating card; it is kept in memory. The server must list the browser's actual Origin:

```sh
uv run --project policy stackling-policy serve \
  --profile data/profile.json --factory stackling_policy.examples.replay:create \
  --policy-id replay-demo --model-revision replay-demo-v1 \
  --host 0.0.0.0 --origin http://127.0.0.1:5180 --origin http://127.0.0.1:5280

# Use a fixed Chromium page port that matches the allowed Origin above
bun run cli -- collect --policy ws://GPU_HOST:8000/policy --port 5280 \
  --out data/remote --seeds 42,2026
```

Use the actual Vite address for the UI Origin. Do not put tokens in URLs. The default request timeout is 30 seconds; episode initialization has a 120-second timeout. Override these with `--timeout-ms` and `--initialization-timeout-ms` in the CLI. `--strict-environment` rejects a Profile from another environment build instead of warning; see the [protocol](../protocol/README.md). A running Python callback cannot be forcibly cancelled. Resetting or disconnecting discards old actions, and the server remains busy until the callback returns.

The read-only health endpoint is `GET /health`. This version does not provide public deployment, training APIs, automatic reconnection, multiple active sessions, DAgger or teacher takeover.

## Verification and contracts

```sh
bun run check:policy
uv run --project policy pytest policy/tests -q
```

See [Protocol](../protocol/README.md) for wire fields, timing, errors and encoding, and [Architecture](../docs/architecture.md) for module boundaries. The shared schema has one source at `protocol/schema.json`; the Python source package references it through a symlink. Keep generated data and weights in ignored directories such as `data/`, not in Git.
