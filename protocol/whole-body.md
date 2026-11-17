# Whole-body environment contract

`stackling-v5.4` is the only runtime environment. Browser, CLI, teacher, replay and external policies use the same articulated humanoid and absolute action layout. `configs/default.json` and `configs/robot.json` own the configuration. This revision runs Rapier, motor updates and contact feedback in native Rust, hosted by independent Bun workers. Three.js consumes measured frames through the [runtime host contract](runtime-host.md). Explicit mass properties, solver settings, compliant jaw centering, bounded teacher paths and force/slip feedback remain part of the physical contract.

## Absolute actions and measured state

Actions and measured states contain sixteen values:

| Indices | Values                          | Units   |
| ------- | ------------------------------- | ------- |
| 0–1     | Waist yaw, forward pitch        | radians |
| 2–7     | Negative-X arm q1–q6            | radians |
| 8       | Negative-X gripper internal gap | metres  |
| 9–14    | Positive-X arm q1–q6            | radians |
| 15      | Positive-X gripper internal gap | metres  |

Y is up; the robot faces +Z in its neutral pose. Positive waist pitch leans forward. The pedestal remains fixed. Waist limits/speed/acceleration and each arm's limits come from the validated robot configuration. Per-arm seven-value types are internal components of this layout, not a second supported world action format.

Targets are commands and states are measured physical values. Both arms and waist use motor joints; grasping uses bilateral friction, without attaching or relocating objects. The shared Runner schedules all actions on control ticks with an unchanged physical timestep. The `continuous` flag selects sampled continuous tracking versus a waypoint that stops precisely; it does not change target ordering, limits, units or physics clocks.

Python policies use this layout through `stackling.policy`. A model returns an `ActionTarget` containing the sixteen absolute values and its tracking flag.

Task-specific planners share the whole-body executor. It chooses arm, waist and top/side/oblique grasps, verifies physical release and carries one object at a time. Partition transfers use actual table placements. Task scoring and maximum-height deadlines are independent of teacher status. Current teacher/task/theme versions remain separate provenance identities.

## Physical model and diagnostics

Each moving robot part has mass in kg, local center of mass in m, principal moments in kg·m² and a local principal-frame quaternion `[x,y,z,w]`. Principal moments must be positive and satisfy the inertia triangle inequalities; frames must be unit quaternions. Robot colliders have zero density. Changing their envelopes cannot implicitly change mass properties. The default `uniform-solids-estimate-v1` freezes uniform-solid estimates from the current geometry, with a volume-weighted 12-kg torso. These are simulation estimates, not hardware calibration or a reflected joint-armature model. The former isotropic `rotorInertia` body addition is removed.

The two prismatic jaws share a compliant common-mode centering spring/damper. Each jaw's own term is solved implicitly through its capped motor; the opposite jaw's state is sampled once per physics step. This is a compliant control coupling, not an exact mechanical gear constraint. Finger, arm and waist motors retain their physical force/torque caps. Solver iteration counts are explicit environment configuration; changing them changes compatibility and provenance without changing the physics clock.

Contact normal force is positive solved normal impulse divided by the physics timestep. `frictionLimit` is the sum of μ times normal force, a Coulomb capacity bound, not measured tangential force. `slipSpeed` is normal-impulse-weighted relative tangential speed at contacting points (including both bodies' angular velocity); `friction` is impulse-weighted manifold friction. Only positive-impulse contacts count. No contact produces zero values.

Contact-pair measurements include active solver pairs and compute current signed separation by reprojecting local narrow-phase anchors with the present collider poses and manifold normal. Cached narrow-phase distances can survive separation and are not current measurements. Environment 5.4 corrects this measurement without changing physical integration or solver settings.

Actuator `velocity` is measured relative angular velocity projected on the world joint axis. References are the last applied internal motor position/velocity; torque estimates evaluate explicit PD plus the recorded gravity term against current measured state. `limitedTorqueEstimate`/`limitedForceEstimate` clamp this demand to the configured cap. The exported diagnostic contract retains PD estimates rather than native motor impulses: these estimates do not report actual solver output or joint-stop/contact reactions. `anchorError` measures the distance between physical joint anchors. Diagnostics at tick zero precede the first applied motor step.

## Dataset schema 10

Full run manifests and episode metadata declare `kind: "dataset"` and `schemaVersion: 10`. Evaluation manifests and result records declare `kind: "evaluation"` and `schemaVersion: 2`. Readers and resume operations verify kind before version. Records retain `provenance.environmentFingerprint` for environment compatibility and `provenance.sourceHash` for the complete runtime source identity. The `provenance.physics` object identifies the Rust source, compiled binary, compiler, flags and target platform. Physics replay requires a dataset recording with its action rows and camera transforms.

- `obs.state`, `act.executed`, `act.teacher_action`, `diag.state` and `diag.target` have width 16.
- `act.continuous` retains the motor-tracking flag for every target, including policy responses and offline replay.
- `diag.actuators` is float64 `[D,14,9]`: waist yaw/pitch, negative-X arm six joints, positive-X arm six joints. Fields are `reference`, `referenceVelocity`, `velocity`, `gravityTorque`, `requestedTorqueEstimate`, `limitedTorqueEstimate`, `torqueLimit`, `trackingError`, `anchorError`; angles/velocities use rad and rad/s, torques N·m, anchor error m.
- `diag.fingers` is float64 `[D,2,2,6]`, with arm then negative/positive local-Z jaw. Fields are `position`, `velocity`, `reference`, `referenceVelocity`, `requestedForceEstimate`, `limitedForceEstimate`; linear quantities use m and m/s, forces N. Positions are displacement from the home-gap jaw anchor.
- `diag.contacts` is float64 `[D,2,B,2,5]`, with arm, object and jaw axes. Fields are `normalForce`, `frictionLimit`, `slipSpeed`, `friction`, `points` (N, N, m/s, dimensionless, count).
- `diag.tcp` is float64 `[D,2,8]`: both measured TCPs as `[x,y,z,gap,qx,qy,qz,qw]` in world coordinates. `diag.blocks` is `[D,B,13]`: world position, quaternion, linear velocity and angular velocity. `D` is diagnostic rows and `B` is object count. `metadata.format.diagnostics` stores these exact field definitions; all diagnostics remain privileged and excluded from standard observations.
- `obs.camera_to_world` is float64 `[observations,4,4]`, a **row-major** homogeneous transform from camera coordinates to world coordinates at the exact observation tick. Camera axes are right, up, backward; optical depth is positive forward distance.
- Internal observation rows, wire `cameraToWorld` and static calibration use Three.js column-major flat elements. The writer transposes to conventional NPZ matrices; Python exposes the per-frame transform as float64 `[4,4]`.
- Calibration describes intrinsics and the neutral mounting pose. Moving head cameras require the per-frame transform. External capture cameras supply constant transforms while their configuration stays fixed. Main-view changes never alter observations.

Inspect validates schema, diagnostic field definitions and finiteness, sixteen-value widths, clocks and camera transforms. Replay checks the expanded diagnostics as well as recorded absolute targets, tracking flags and resolved initial poses through the same physical loop. Resume preserves the declared seed plan and rejects incompatible source, configuration, generation, appearance or model identity; completed episodes and failed outcomes remain immutable.
