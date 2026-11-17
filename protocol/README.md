# External policy protocol

[`schema.json`](schema.json) is the authoritative wire format for `stackling.policy`.
TypeScript validates with Ajv 2020; Python validates with jsonschema. Python's
package resource is a symlink to this file, not an independent schema copy.
[`fixtures.json`](fixtures.json) exercises both validators and RFC 8785/JCS hashing.

## Profile and identity

Export a complete profile with `policy-profile`; Python does not merge defaults.
The Profile fixes the runtime and I/O contract: physical environment and robot, camera/calibration, control and observation rates, and image/state/action encodings. `trainingTasks` and `trainingAppearance` are immutable training provenance, not an execution allowlist. `trainingTasks` may be empty when coverage is unknown. Every episode independently chooses its validated scene, goal, prompt, time limit, scene/camera seeds and actual appearance. Teacher parameters are local and excluded from the Profile.
`profileId` is a human-readable identifier. `profileHash` is SHA-256 of the JCS
encoding of the complete profile, as lowercase hex.

The actual-config hash covers `{configuration: profile.config, taskCase, seed, cameraSeed, appearance}`. The local
teacher configuration is still saved in dataset metadata but is not part of the
model contract. The environment compatibility fingerprint covers World runtime geometry/colliders/actuators, Rust sources and locked dependencies, the native bridge/build identity, common rendering and sensor modules, the runtime projection of defaults, robot description, Episode scheduling, frame capture/encoding and exact Three/fflate versions. It excludes task definitions, prompt templates, scene/default-inventory configuration, the pure configuration resolver and random helper, independent theme contents/registration, UI, documentation and Python model code. Actual runtime values are also compared against the Profile; independent full-source provenance still detects task/scoring/source changes when resuming data. AppearanceIdentity carries the theme source hash and version separately; rendering helpers remain part of the core fingerprint. A separately
recorded full-source hash also covers the shared protocol and build inputs.
The runtime contract is enforced through the Profile configuration: binding and every episode start reject a runtime
configuration that differs from `profile.config`. The fingerprint identifies one build, including its native binary,
compiler and platform, so it differs between machines running the same source. A fingerprint that differs from the
client's build is reported, not rejected: the UI shows it in the Policy card, the CLI warns on stderr and rejects with
`ENVIRONMENT_MISMATCH` only under `--strict-environment`. Episode records keep both the Profile's fingerprint and
the executing build's. Results from a differing build are not comparable with results from the Profile's build, and replaying
recorded actions needs the same build. Models must have an immutable
`policyId` and `modelRevision`; updating weights requires a new revision.

## Session

The client connects to the WebSocket endpoint `/policy` and requests subprotocol
`stackling.policy`. All requests and
responses have `type`, `sessionId`, `episodeId` and `requestId`. The client creates
a random session ID, uses strictly increasing positive request IDs and creates a
fresh episode ID for every start. Before an episode, `episodeId` is null. Responses
repeat the exact envelope of their request. A missing or unrecognized WebSocket subprotocol closes the connection with code 1002.

| Request → response                | Payload                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `hello` → `manifest`              | Token (empty for local access without authentication) → identity, complete profile and profile hash                                        |
| `configure` → `configured`        | Profile hash, runtime `configuration`, `configurationHash` and calibration → accepted runtime hash               |
| `episode_start` → `episode_ready` | Complete `actual` episode configuration and `configHash`; validates current task/prompt and resets model history |
| binary `observation` → `observed` | Tick, time, measured state and encoded images → accepted tick                                                    |
| `act` → `action`                  | Tick, control period, last acknowledged observation request ID → tick, Action16D and continuous-tracking flag     |
| `episode_end` → `episode_ended`   | Outcome, reason, final tick and simulated seconds; no world snapshot                                             |

One authenticated connection owns the model lease, including profile review and
idle periods. Additional authenticated clients receive `SERVER_BUSY`. Disconnect
releases the lease only after running callbacks and model cleanup finish.
`configure` is accepted once; build a candidate world before sending it and only
replace the applied world after acknowledgement. Calibration is checked against
the profile's camera. Each start validates the dynamic scene/task/prompt and the complete actual-config hash. Runtime configuration must still match the Profile exactly. Task, scene, seeds and appearance may change without modifying the Profile or rebinding the connection. The service validates identity shapes and the complete actual-config hash; client-installed module hashes and dataset source provenance bind the identity to rendered content.

The server executes synchronous callbacks in order on one dedicated thread.
Inference duration does not advance simulated time. A callback cannot be forcibly
cancelled: clients cancel their waits and discard the corresponding late reply.
A queued `episode_end` follows the executing callback; no new episode starts until
it is acknowledged. A disconnected client cannot pass the model's state to a new
session while a callback is running.

Default request deadline is 30 seconds and initialization deadline is 120 seconds.
Client connection options may change these wall-clock limits without modifying
the profile. Server `--handshake-timeout` bounds unauthenticated waiting. A timeout
faults the binding and closes the transport. No late response can execute an action.

## Observation and action semantics

Coordinates are right-handed, Y up, north = −Z and east = +X. Length is metres;
angles are radians. Action16D contains waist yaw/pitch followed by the negative-X arm's six absolute joint targets and gap, then the positive-X arm's six targets and gap. State16D uses the same ordering but contains measured values. Angles use radians and gaps use metres; limits are validated for all sixteen values. See the [whole-body contract](whole-body.md#absolute-actions-and-measured-state).

Each observation is one binary WebSocket message:

```
uint32 little-endian JSON-header byte length
UTF-8 JSON header
rgbBytes bytes of PNG
 depthBytes bytes of gzip depth (omitted when zero)
```

The header has the common envelope, `type: "observation"`, `tick`, `time`,
`state[16]`, `cameraToWorld[16]`, `rgbBytes` and `depthBytes`. There are no other fields. Message size is
at most 128 MiB; the header is at most 64 KiB. Text control messages are at most
64 KiB. Payload length and decoded image dimensions must match exactly.

RGB is top-left-origin PNG (the renderer encodes RGBA; the Python boundary decodes
RGB uint8 `[H,W,3]`). Depth is gzip-compressed uint16 **little-endian millimetres**,
`[H,W]`, zero invalid, with the same exposure and pixel origin. It is distance
along the optical axis, not Euclidean distance to the camera. Calibration uses
pixel centres at half-integers and a column-major Three.js camera-to-world matrix
with right/up/backward axes; positive depth points along camera −Z.

The camera object requires explicit `mount: "external" | "head"` and `head` optics. Resolved configurations also require table depth/support and an articulated body. Configure calibration describes neutral mounting geometry; every observation includes the actual `cameraToWorld` at its tick. Head captures move with the waist while remaining independent of the main viewport. Wire/calibration flat matrices are column-major; Python receives a float64 4×4 transform. See [whole-body recording](whole-body.md#dataset-schema-10).

Both rates divide physicsHz. At a shared tick, observation is acknowledged before
action is requested; control ticks with no new observation reference the most
recent one. Observation clocks may be faster or slower than control clocks. There
is at most one unacknowledged observation or action in flight. Stop may additionally
queue one end request. Samples cover `[0,endTime)`; there is no endpoint image.

Model callbacks receive no block poses, contacts, task-score internals, Simulation
or Teacher. `reset` gets shared runtime configuration, calibration and `TaskContext(prompt, language, control_seconds)`; no selected case ID, template ID, structured goal, inventory or time limit is hidden in its config; appearance labels and trainingAppearance are not passed to model callbacks; `observe` gets decoded
images, measured state and clock; `act` gets only the control clock and latest
observation ID; `end` gets a result summary. Dataset diagnostic truth stays on the
Stackling side. Model preprocessing, history windows, tensors and action-chunk
caching are entirely user-owned.

## Errors, storage and deployment

Well-formed requests may receive `error` with a stable `code` and `params.detail`.
Codes are enumerated in the schema and localized in the UI. Invalid framing or
untrustworthy envelopes close the connection with WebSocket code 1008; clients
report a disconnected binding. Internal model exceptions produce `MODEL_ERROR`.

Task success, timeout, teacher failure and normal height `completed` are experimental results. Object drops do not immediately terminate a task.
Transport, protocol and model errors are infrastructure failures: stop scheduling,
retain the partial directory plus interruption reason, and exit CLI nonzero. They
do not invoke the teacher-failure hold step. New datasets use schemaVersion 10;
each episode stores an H.264 video of observations (VP9 fallback where the
browser lacks H.264) plus a columnar npz of states,
actions and diagnostics; metadata adds the manifest and actual-config hash, the
npz key table and the video encoding parameters. External actions omit teacher
labels. Replay needs no policy server. Resume requires
the same profile, model identity, full source, browser and complete episode plan.

The default server listens on loopback. LAN binding requires
`STACKLING_POLICY_TOKEN` and explicit `--origin` values. Tokens travel in `hello`,
never query strings, dataset metadata or persistent UI state. Browser Origin is
validated when present. Non-browser clients authenticate with the same token.
Use a fixed CLI browser port with a matching allowed Origin on LAN. The service supports one active policy session on a trusted network.

## Prompt-only multitask boundary

`Profile.config` contains shared environment/camera/rates; its `run` object has only `controlHz` and `observationHz`. `trainingTasks[]` retains example training scenes/goals/prompts without restricting execution. The one-time configure message contains no selected task or theme. Each `episode_start.actual` contains `configuration`, `taskCase`, scene `seed`, `cameraSeed` and actual `appearance`. `taskCase` contains `scene`, `task`, `maxSeconds` and the versioned generated `prompt`; there is no Profile case index. The service validates this descriptor and hash independently of training coverage.

The model callback receives only the current prompt text, language and operation time budget through `TaskContext`. Scene geometry, structured goals, template/case identifiers and appearance labels remain adapter/dataset information. `EpisodeContext.config` contains only the runtime contract. Call `reset` once before the first observation of each episode and cache its instruction for `observe`/`act`; starting another task resets model history and supplies that episode's prompt. The simulator retains ownership of instruction generation and independent scoring.

Height validation stops model observe/act requests at the operation deadline while local sampling and system holds continue. `episode_end` follows final validation; `completed` is a legal normal outcome. Dataset system rows are never policy/teacher training actions.

## Python action result

The model callback returns `ActionTarget(action=[16 absolute values], continuous=False)`. Set `continuous=True` for sampled continuous tracking. The server validates the result and returns both `action` and `continuous` in the action message; the TS adapter preserves the flag through motor application and recording.

The binary observation header requires `cameraToWorld`, sixteen column-major float64-compatible values captured with its measured state and RGB/depth. `Observation.camera_to_world` is a float64 4×4 NumPy matrix with the same transform. It is sensor calibration, not privileged object state.
