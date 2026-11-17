#!/usr/bin/env bash
# Collect teacher demonstrations as independent shard processes.
#
# One collector process stops scaling beyond a few workers, so throughput comes
# from many processes with WORKERS (default 2) workers each. Every shard is a
# complete dataset with its own manifest and a disjoint seed range.
#
# Worker i of every process renders on GPU i, so two workers need free memory
# on GPUs 0 and 1 (about 130 MiB per browser). WORKERS=1 keeps all rendering on
# GPU 0 while other GPUs are full.
#
# CAMERA (default vla/configs/head-camera.json) selects the camera override.
# CONFIGS names a directory with one complete config per shard (shard-NNN.json,
# see stackling_vla.layouts) and replaces CAMERA and the default two cubes.
# JOBS (default: all shards) limits how many shards run at once.
#
#   vla/scripts/collect.sh OUT_ROOT SHARDS EPISODES_PER_SHARD SEED_BASE [extra collect options]
set -euo pipefail
out=$1 shards=$2 episodes=$3 base=$4
shift 4
cd "$(dirname "$0")/../.."
bun run build:physics >&2
mkdir -p "$out/logs"
# The shard loops below retry on their own; stopping the script must stop them too.
trap 'trap - TERM; kill 0' INT TERM
for i in $(seq 0 $((shards - 1))); do
  name=$(printf 'shard-%03d' "$i")
  layout=(--blocks 2 --config "${CAMERA:-vla/configs/head-camera.json}")
  [ -n "${CONFIGS:-}" ] && layout=(--config "$CONFIGS/$name.json")
  while [ "$(jobs -rp | wc -l)" -ge "${JOBS:-$shards}" ]; do sleep 2; done
  # A collector exits on recorder or browser errors, which occur under load; resuming keeps its completed episodes.
  (
    for attempt in $(seq 1 20); do
      [ -e "$out/$name/manifest.json" ] && resume=--resume || resume=
      bun src/app/cli/main.ts collect --task-preset stack-all "${layout[@]}" --workers "${WORKERS:-2}" \
        --seed $((base + i * episodes)) --episodes "$episodes" \
        --out "$out/$name" $resume "$@" >>"$out/logs/$name.log" 2>&1 && break
      echo "[collect] $name: attempt $attempt failed" >>"$out/logs/$name.log"
      sleep 5
    done
  ) &
  sleep 0.5
done
total=$((shards * episodes))
start=$(date +%s)
while [ -n "$(jobs -rp)" ]; do
  sleep 30
  # Staging directories vanish while find walks them; that is not an error.
  done_count=$(find "$out" -path '*/episodes/[0-9]*' -name metadata.json 2>/dev/null | wc -l || true)
  elapsed=$(($(date +%s) - start))
  echo "[collect] $done_count/$total episodes, ${elapsed}s elapsed, $(jobs -rp | wc -l) shards running" >&2
done
failed=0
for i in $(seq 0 $((shards - 1))); do
  name=$(printf 'shard-%03d' "$i")
  grep -q '"status":"complete"' "$out/logs/$name.log" || { echo "[collect] $name incomplete" >&2; failed=1; }
done
exit $failed
