# AGENTS.md

## Working principles

- Occam's Razor: implement the simplest solution that satisfies the requirement. Add no abstraction, dependency or flexibility without a concrete need.
- No defensive programming: validate external input at the boundary, then trust established invariants and types. Do not add fallback paths or repeated checks for conditions the code already makes impossible.
- No test-first development: implement directly, then verify by running the affected checks. Do not write failing tests before code or add tests merely to satisfy process; extend automated suites only when pinning behavior that actually regressed.
- Use Bun and strict TypeScript. Keep bun.lock synchronized with dependency changes.
- Manage Python dependencies with uv and keep uv.lock synchronized.
- Use English for all repository documentation, identifiers, code comments, commit messages and PR titles. Keep UI text bilingual through shared Chinese/English locale resources.

## Unix philosophy

- Give each module and command one clear responsibility; compose capabilities through small, explicit input/output contracts.
- Separate mechanism from policy: physics, scheduling, task definitions, action selection, recording and reporting must have clear ownership. Add a task or model without teaching unrelated layers its special cases.
- Make configurations, plans and results explicit, serializable and inspectable. Prefer structured text for metadata and appropriate binary formats for images and arrays; preserve deterministic replay and provenance.
- Keep reusable capabilities accessible independently of UI orchestration. Compose existing functions and artifacts before adding another workflow or framework.
- Keep CLI data output machine-readable on stdout and send progress and diagnostics to stderr. Report configuration and infrastructure errors with nonzero exit codes; preserve task failures as ordinary result data.
- Choose boundaries for independent use and replacement. A shared process is appropriate when it preserves timing or performance; do not split processes or add plugin systems merely for architectural purity.

## Architecture and simulation

- Follow the source ownership and import directions in docs/architecture.md. Run `bun run check:architecture` when changing module boundaries.
- Keep simulation/world independent of control, runtime and app. The physics core must not require DOM or WebGL.
- simulation/control produces actions. runtime/episode owns episode scheduling. CLI and UI must use the same execution loop.
- Preserve the distinction between target actions, measured states and privileged world snapshots. Keep privileged diagnostics out of standard model inputs.
- Use real physics for grasping and independent task scoring. Do not fake success by moving bodies or attaching blocks to the gripper.
- Use simulation time for task logic. Playback speed must not change the physics timestep or skip scheduled simulation steps.
- Keep sensor observations independent of the main viewport and UI overlays.

## Policy and dataset boundaries

- Keep the current policy contract in `protocol/schema.json`. Update its producers and consumers together when it changes.
- Adapt individual models in Python and preserve shared World and Episode semantics. Return validated absolute Action16D targets for waist yaw/pitch, both six-joint arms and both gripper gaps.
- Export profiles through the configuration resolver. Preserve training configuration; never bypass compatibility or provenance checks to bind a model.
- Preserve the declared seed plan and failed task results. Never overwrite completed episodes or mix incompatible runs when resuming.

## UI

- Target desktop use; validate desktop layouts. Mobile UI is not a requirement.
- Reuse shadcn/ui and existing libraries for components and interaction behavior. Do not reimplement capabilities they already provide.
- Keep the interface restrained and consistent with the island scene. Avoid decorative captions, explanatory small text and unnecessary animation.
- Derive controls from shared state permissions. Enforce those permissions at command and keyboard entry points.
- Keep configuration drafts separate from applied settings. Preview edits, commit on Apply, and restore the original scene on Cancel.

## Verification and documentation

- Run checks relevant to the change; see package.json. Verify UI changes in a real browser. Report what passed and what was not run.
- Do not weaken acceptance criteria, omit failed seeds or present historical results as newly verified.
- Never commit generated reports, logs, validation screenshots or benchmark output, including curated acceptance artifacts. Keep outputs in ignored directories.
- Treat changes to physics, scoring, timing, sensors, observation/action semantics or wire formats as environment/protocol work, with appropriate versioning and regression checks. Preserve configuration, seed and provenance records.
- Keep one home for each fact: README.md for quick starts, docs/usage.md for CLI usage, docs/architecture.md for runtime contracts, and protocol/ for wire definitions. Reference the owning document instead of duplicating specifications.
