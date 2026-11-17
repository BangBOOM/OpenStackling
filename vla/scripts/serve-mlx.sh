#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
export UV_PROJECT_ENVIRONMENT=${UV_PROJECT_ENVIRONMENT:-"$HOME/.venvs/stackling-vla-mlx"}
export STACKLING_VLA_BASE=${STACKLING_VLA_BASE:-"$HOME/Models/stackling/MiniCPM-V-4.7-1B"}
export STACKLING_VLA_CHECKPOINT=${STACKLING_VLA_CHECKPOINT:-"$HOME/Models/stackling/two-cube-head-v1"}
export STACKLING_VLA_ATTEMPT=${STACKLING_VLA_ATTEMPT:-20}
export STACKLING_VLA_SAMPLES=${STACKLING_VLA_SAMPLES:-3}
export STACKLING_VLA_FLOW_STEPS=${STACKLING_VLA_FLOW_STEPS:-2}
export STACKLING_VLA_BITS=${STACKLING_VLA_BITS:-0}
precision=bf16
if [[ "$STACKLING_VLA_BITS" != 0 ]]; then
  precision="int$STACKLING_VLA_BITS"
fi

exec uv run --project "$ROOT/vla" --extra mlx --locked stackling-policy serve \
  --profile "$STACKLING_VLA_CHECKPOINT/profile.json" \
  --factory stackling_vla.mlx_serve:create \
  --policy-id stackling-vla \
  --model-revision "two-cube-head-v1-step-007000-mlx-${precision}-s${STACKLING_VLA_SAMPLES}-f${STACKLING_VLA_FLOW_STEPS}" \
  "$@"
