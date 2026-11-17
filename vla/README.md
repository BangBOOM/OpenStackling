# Stackling VLA

A flow-matching vision-language-action policy for head-camera stacking, built on MiniCPM-V-4.7-1B. The backbone encodes one camera frame and the episode instruction; an action expert cross-attends to its hidden states and denoises a chunk of the next 32 control targets, conditioned on the measured State16D and optionally on a few earlier states. The policy talks to the simulator only through the [external policy service](../policy/README.md).

## Contract

- Observation: head camera at 504x392 (`configs/head-camera.json`), which maps one-to-one onto the vision tower's 14-pixel patch grid. RGB only, one frame, the current measured state and, with `--history`, a few earlier ones.
- Action: `codec.py`. Joint targets are encoded relative to the measured state at the chunk's observation and scaled per horizon step; gripper gaps are absolute; the tracking flag is a seventeenth channel. Chunk entry 0 belongs to the control tick of its observation.
- Serving plans a new chunk every `STACKLING_VLA_EXECUTE` control ticks (default 8) on a tick that carries a fresh observation. `STACKLING_VLA_SAMPLES=N` draws N chunks per plan and executes their medoid.
- `STACKLING_VLA_ATTEMPT=SECONDS` divides the episode into attempts: after a gripper that carried something opens, or after that many seconds, the robot returns to its initial posture and the policy starts over with cleared memory. Demonstrations all start from that posture, so the second transfer of a relocated cube and the retry after a miss begin in situations they cover. The published checkpoint is served with 20 seconds and eight samples.

## Environment

Keep the virtual environment outside the repository: the simulator's dev server watches the working tree.

```sh
export UV_PROJECT_ENVIRONMENT="$HOME/.venvs/stackling-vla"
uv sync --project vla --extra cuda
PY=$UV_PROJECT_ENVIRONMENT/bin
```

The pretrained model is MiniCPM-V-4.7-1B (`OpenBMB/MiniCPM-V-4.7-1B` on ModelScope). `train --base DIR` names its directory (default `MiniCPM-V-4.7-1B` in the working directory) and every checkpoint records that path. A checkpoint holds all trained weights but takes the architecture, tokenizer and frozen token embeddings from the pretrained model, so serving needs it as well; `STACKLING_VLA_BASE=DIR` replaces the recorded path.

## Collect and pack demonstrations

One collector process stops scaling beyond a few workers, so `scripts/collect.sh` runs many two-worker shard processes with disjoint seed ranges. Worker i of each process renders on GPU i; set `WORKERS=1` to keep rendering on GPU 0 while training fills the other GPUs. `CAMERA=vla/configs/front-high-camera.json` collects from another camera, and `evaluate --camera` must name the same file. Shards that exit on recorder or browser errors are resumed automatically. `JOBS=N` limits how many shards run at once.

```sh
vla/scripts/collect.sh DATA_ROOT 40 300 100000   # 40 shards x 300 episodes from seed 100000
$PY/python -m stackling_vla.prepare --data DATA_ROOT --out INDEX
```

`prepare` takes one or more data roots, keeps successful episodes whose video holds every observation frame, holds out 2% of episodes for validation and writes the normalization statistics into `INDEX/meta.json`.

Default layouts hold axis-aligned cubes with gripper clearance between them; a cube the policy has moved is usually turned and may lie next to the other one. `stackling_vla.layouts` writes one config per shard with turned cubes, optional zero clearance and small sampling regions, and `CONFIGS=DIR` makes `collect.sh` use them:

```sh
$PY/python -m stackling_vla.layouts --out DATA_ROOT/configs --shards 400
WORKERS=1 JOBS=72 CONFIGS=DATA_ROOT/configs vla/scripts/collect.sh DATA_ROOT 400 30 400000
```

## Train

```sh
cd vla
CUDA_VISIBLE_DEVICES=1,2,3,4,5 $PY/torchrun --nproc_per_node 5 -m stackling_vla.train \
  --data INDEX --out RUN --steps 16000 --compile
```

`--history 10,20,40,80` also feeds the states measured that many observations earlier (1, 2, 4 and 8 s); the published checkpoint uses it on an index packed from default and `layouts` demonstrations together. `--anchor`, `--state-noise` and `--shift` are optional variants that the published checkpoint does not use. `--init CHECKPOINT` continues from a checkpoint, keeping its architecture and normalization statistics, so the index may hold more data than the one it was trained on. `--long-episode-weight W` samples observations from episodes longer than `--long-episode-seconds` (default 18) W times as often; those are the layouts where one cube is relocated before stacking.

Every `RUN/step-NNNNNN` holds `config.json` and the EMA weights. `RUN/log.jsonl` records the flow loss, throughput and, on validation steps, the sampled-chunk error in radians over the first eight control ticks. Gradients are accumulated locally (`--accumulate`) and exchanged in bfloat16, because the exchange dominates step time on GPUs without a fast interconnect.

## Evaluate

```sh
cd vla
$PY/python -m stackling_vla.evaluate --checkpoint RUN/step-007000 \
  --env STACKLING_VLA_ATTEMPT=20 --env STACKLING_VLA_SAMPLES=8 \
  --seed 920000 --episodes 400 --shards 24 --gpus 1,2,3 --out EVAL_DIR
```

Each shard pairs one policy service with one result-only evaluator (`--record` keeps full recordings); `--env` passes serving options; the summary is JSON on stdout and in `EVAL_DIR/summary.json`. Evaluator browsers render on GPU 0, so keep it out of training while evaluating. `scripts/watch-eval.sh` evaluates every new checkpoint of running jobs on fixed development seeds.

`stackling_vla.oracle:create` is a diagnostic factory that replays recorded teacher chunks through the same serving path, optionally with injected joint noise. It validates the codec and chunk timing and measures the action accuracy the task needs; it predicts nothing from images.

## Serve

`evaluate` starts its own services. To serve one checkpoint for the UI or for CLI runs, export the Profile for the camera and task the model was trained with and start the [policy service](../policy/README.md) with the model factory:

```sh
bun run cli -- policy-profile --task-preset stack-all --blocks 2 \
  --config vla/configs/head-camera.json --out PROFILE
STACKLING_VLA_CHECKPOINT=CHECKPOINT STACKLING_VLA_ATTEMPT=20 STACKLING_VLA_SAMPLES=8 \
  $PY/stackling-policy serve --profile PROFILE --factory stackling_vla.serve:create \
  --policy-id stackling-vla --model-revision REVISION
```

`CHECKPOINT` is a directory with `config.json` and `model.safetensors`. The service listens on `ws://127.0.0.1:8000/policy`, loads the model once at startup and takes about 3.3 GB on the GPU selected by `CUDA_VISIBLE_DEVICES`. Connect from the UI (`bun run dev`, **External Policy**) or from the CLI:

```sh
bun run cli -- evaluate --policy ws://127.0.0.1:8000/policy --task-preset stack-all --blocks 2 \
  --config vla/configs/head-camera.json --seed 300000 --episodes 8 --out EVAL_DIR
```

## Apple Silicon inference (MLX)

The MLX backend runs the vision tower, twelve-layer language prefix and action expert on the Mac GPU. It loads the original checkpoint directly, maps the tensor layouts and RMSNorm weights, and defaults to bfloat16 weights with float32 flow integration. The entire sampling graph is compiled with `mx.compile`; fixed camera position indices are prepared at load time, and cross-attention K/V and state projections are reused within each plan. Tokenization uses MLX-VLM's NumPy/Pillow processor; serving does not require PyTorch or CUDA. Chunk execution, history, action decoding and attempts are shared with the CUDA adapter.

Install with uv (the project uses the Tsinghua PyPI mirror) and keep the environment outside the repository:

```sh
export UV_PROJECT_ENVIRONMENT="$HOME/.venvs/stackling-vla-mlx"
uv sync --project vla --extra mlx --locked
```

Download the base and published checkpoint from ModelScope. No demonstration dataset is needed for serving.

```sh
uv run --project vla --extra mlx modelscope download OpenBMB/MiniCPM-V-4.7-1B \
  --revision a916b697f04f297cceffe29895d2b1f1f73611ee \
  --local-dir "$HOME/Models/stackling/MiniCPM-V-4.7-1B"
MODELSCOPE_DOWNLOAD_PARALLEL_WORKERS=8 uv run --project vla --extra mlx \
  modelscope download bangboom/stackling-vla-two-cube-head-v1 \
  --local-dir "$HOME/Models/stackling/two-cube-head-v1"
```

Start the published checkpoint with the faster Mac sampling settings: three candidates, two flow steps, eight executed targets per plan and 20-second attempts. The CUDA serving example above uses eight candidates and the default ten flow steps:

```sh
vla/scripts/serve-mlx.sh
```

The launcher uses the paths above and the checkpoint's original `profile.json`, and forwards extra arguments to `stackling-policy serve` (for example `--port 8001`). `STACKLING_VLA_BASE` and `STACKLING_VLA_CHECKPOINT` override the directories; the existing serving options also apply. It logs planning latency and MLX peak allocated memory to stderr. The service listens at `ws://127.0.0.1:8000/policy` by default. Its model revision includes the precision, candidate count and flow steps.

To use the same sampling settings as the CUDA example, run `STACKLING_VLA_SAMPLES=8 STACKLING_VLA_FLOW_STEPS=10 vla/scripts/serve-mlx.sh`. Optional `STACKLING_VLA_BITS=4` or `8` enables experimental affine weight quantization with group size 64 for aligned linear layers; embeddings, normalization, convolutions, small action input/output projections and non-aligned matrices remain unquantized. Quantization is performed in memory without modifying either downloaded checkpoint. It is not enabled by default and showed no latency benefit in initial measurements.

Measure warmed planning latency, including preprocessing, candidate selection and CPU output, independently of the simulator:

```sh
uv run --project vla --extra mlx --locked python vla/scripts/benchmark-mlx.py \
  --base "$HOME/Models/stackling/MiniCPM-V-4.7-1B" \
  --checkpoint "$HOME/Models/stackling/two-cube-head-v1" \
  --samples 3 --flow-steps 2 --bits 0 --repeats 30
```

The command emits JSON timings and configuration on stdout. It uses synthetic RGB and zero state by default; `--image /path/to/sensor.png` uses a real sensor image at the training resolution. Timing results do not establish task success; evaluate complete episodes separately.

In another terminal, start `bun run dev` and bind that address in **External Policy**, or run a short evaluation:

```sh
bun run cli -- evaluate --policy ws://127.0.0.1:8000/policy \
  --task-preset stack-all --blocks 2 --seed 300000 --episodes 1 --out data/mlx-smoke
```

The training Profile's Linux build fingerprint differs from a native Mac build; the service retains it and the client reports the difference while enforcing configuration compatibility.

## Layout

| Path | Role |
| --- | --- |
| `src/stackling_vla/model.py` | Backbone, action expert, flow-matching loss and sampling |
| `src/stackling_vla/codec.py` | State and action encoding shared by training and serving |
| `src/stackling_vla/prepare.py`, `data.py` | Pack recorded shards into an index; read training samples from it |
| `src/stackling_vla/train.py` | Multi-GPU training, EMA checkpoints, held-out error |
| `src/stackling_vla/serve.py` | Policy factory: chunked replanning, medoid sampling, attempts |
| `src/stackling_vla/config.py` | Checkpoint configuration shared by CUDA and MLX |
| `src/stackling_vla/mlx_model.py`, `mlx_serve.py` | MLX model inference and policy factory |
| `scripts/serve-mlx.sh` | Local launcher for the published checkpoint on Apple Silicon |
| `scripts/benchmark-mlx.py` | Reproducible warmed MLX planning latency measurements |
| `src/stackling_vla/evaluate.py` | Sharded evaluation of a checkpoint |
| `src/stackling_vla/layouts.py`, `scripts/collect.sh` | Recovery-layout configs; sharded teacher collection |
| `src/stackling_vla/oracle.py` | Diagnostic factory that replays teacher chunks |
| `scripts/watch-eval.sh` | Evaluate new checkpoints of running jobs |
| `configs/` | Head camera of the published checkpoint; two alternative external cameras |

The published model, the packed indexes and the demonstrations are in public ModelScope repositories:

| Repository | Content |
| --- | --- |
| model `bangboom/stackling-vla-two-cube-head-v1` | Published checkpoint with its Profile, training arguments, log and `provenance.json` |
| dataset `bangboom/stackling-tower2` | `index/tower2-v1/`, `index/tower2-v1v3/`, and `raw/SET/*.tar` holding the demonstrations `tower2-v1` (default layouts) and `tower2-v3` (recovery layouts) with one archive per shard |

Download what a task needs with the `modelscope` CLI:

```bash
modelscope download OpenBMB/MiniCPM-V-4.7-1B --revision a916b697f04f297cceffe29895d2b1f1f73611ee --local-dir BASE
modelscope download bangboom/stackling-vla-two-cube-head-v1 --local-dir CHECKPOINT
modelscope download bangboom/stackling-tower2 --repo-type dataset --include 'index/tower2-v1v3/*' --local-dir DATASET
modelscope download bangboom/stackling-tower2 --repo-type dataset --include 'raw/*' --local-dir DATASET
mkdir -p DATA/tower2-v1 && for f in DATASET/raw/tower2-v1/*.tar; do tar -xf "$f" -C DATA/tower2-v1; done
```

Serving needs `BASE` and `CHECKPOINT`, training `BASE` and `DATASET/index/tower2-v1v3`, and rebuilding an index the extracted demonstrations.

Datasets, indexes, checkpoints and evaluation output stay outside Git.
