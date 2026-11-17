#!/usr/bin/env bash
# Evaluate every new checkpoint of the given runs on fixed development seeds.
#
#   vla/scripts/watch-eval.sh EVAL_ROOT GPUS SHARDS SEED EPISODES RUN_DIR [RUN_DIR ...]
#
# EVAL_ARGS holds extra evaluate options, e.g. "--camera CONFIG --port 8200".
# CHECKPOINTS narrows the checkpoint names, e.g. "step-00[456]000" (default: all).
# Stops once every run holds a file named "done" and all checkpoints are evaluated.
set -uo pipefail
root=$1 gpus=$2 shards=$3 seed=$4 episodes=$5
shift 5
python=${STACKLING_VLA_PYTHON:-python}
while true; do
  pending=0
  for run in "$@"; do
    for ckpt in "$run"/${CHECKPOINTS:-step-*}; do
      [ -f "$ckpt/step" ] || continue
      out="$root/$(basename "$run")/$(basename "$ckpt")"
      [ -e "$out" ] && continue
      pending=1
      mkdir -p "$(dirname "$out")"
      echo "[watch] $(date +%H:%M:%S) evaluating $ckpt" >&2
      "$python" -m stackling_vla.evaluate --checkpoint "$ckpt" --seed "$seed" --episodes "$episodes" \
        --shards "$shards" --gpus "$gpus" --out "$out" ${EVAL_ARGS:-} 2>"$out.log" | tee -a "$root/results.jsonl" \
        | sed "s|^|[watch] $(basename "$run")/$(basename "$ckpt") |" >&2
    done
  done
  all_done=1
  for run in "$@"; do [ -f "$run/done" ] || all_done=0; done
  [ $pending -eq 0 ] && [ $all_done -eq 1 ] && break
  [ $pending -eq 0 ] && sleep 20
done
