"""Closed-loop evaluation over parallel policy services.

    python -m stackling_vla.evaluate --checkpoint RUN/step-020000 \
        --seed 900000 --episodes 200 --shards 16 --gpus 0,1 --out EVAL_DIR

The policy service accepts one client, so each shard pairs one service with one
result-only evaluator over a disjoint seed range. The summary is JSON on
stdout; progress and service logs go to stderr and EVAL_DIR/logs.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TASK = ["--task-preset", "stack-all", "--blocks", "2"]


def export_profile(path: Path, camera: str):
    subprocess.run(
        ["bun", "src/app/cli/main.ts", "policy-profile", *TASK, "--config", camera, "--out", str(path)],
        cwd=REPO,
        check=True,
        stdout=subprocess.DEVNULL,
    )


def healthy(port: int) -> bool:
    try:
        return urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1).status == 200
    except OSError:
        return False


def summarize(out: Path) -> dict:
    episodes = []
    for file in sorted(out.glob("shard-*/episodes/[0-9]*/*.json")):
        if file.name not in ("result.json", "metadata.json"):
            continue
        record = json.loads(file.read_text())
        result = record["result"]
        episodes.append(
            {
                "seed": record["config"]["run"]["seed"],
                "outcome": result["outcome"],
                "seconds": round(result["seconds"], 2),
                "completed": result["evaluation"]["completed"],
            }
        )
    successes = sum(e["outcome"] == "success" for e in episodes)
    return {
        "episodes": len(episodes),
        "successes": successes,
        "successRate": successes / len(episodes) if episodes else None,
        "results": episodes,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint")
    parser.add_argument("--factory", default="stackling_vla.serve:create")
    parser.add_argument("--env", action="append", default=[], help="KEY=VALUE for the policy service")
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--episodes", type=int, required=True)
    parser.add_argument("--shards", type=int, default=8)
    parser.add_argument("--gpus", default="0")
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument("--out", required=True)
    parser.add_argument("--record", action="store_true", help="keep full recordings instead of results only")
    parser.add_argument(
        "--camera", default="vla/configs/head-camera.json", help="camera override the checkpoint was trained with"
    )
    args = parser.parse_args()
    out = Path(args.out).resolve()
    (out / "logs").mkdir(parents=True)
    subprocess.run(["bun", "run", "build:physics"], cwd=REPO, check=True, stdout=subprocess.DEVNULL)
    profile = out / "profile.json"
    export_profile(profile, args.camera)
    gpus = args.gpus.split(",")
    shards = min(args.shards, args.episodes)
    revision = Path(args.checkpoint).resolve().as_posix().replace("/", "_")[-60:] if args.checkpoint else "diagnostic"
    extra = dict(item.split("=", 1) for item in args.env)
    if args.checkpoint:
        extra["STACKLING_VLA_CHECKPOINT"] = str(Path(args.checkpoint).resolve())
    servers, logs = [], []
    try:
        for i in range(shards):
            logs.append(open(out / "logs" / f"server-{i:02d}.log", "w"))
            servers.append(
                subprocess.Popen(
                    [
                        str(Path(sys.executable).parent / "stackling-policy"),
                        "serve",
                        "--profile",
                        str(profile),
                        "--factory",
                        args.factory,
                        "--policy-id",
                        "stackling-vla",
                        "--model-revision",
                        revision,
                        "--port",
                        str(args.port + i),
                    ],
                    # The model runs on the GPU; unbounded CPU thread pools of many services starve the simulators.
                    env=os.environ | {"OMP_NUM_THREADS": "2"} | extra | {"CUDA_VISIBLE_DEVICES": gpus[i % len(gpus)]},
                    stdout=logs[-1],
                    stderr=subprocess.STDOUT,
                )
            )
        deadline = time.time() + 600
        while not all(healthy(args.port + i) for i in range(shards)):
            if time.time() > deadline or any(s.poll() is not None for s in servers):
                raise RuntimeError(f"Policy services failed to start; see {out / 'logs'}")
            time.sleep(1)
        per_shard, remainder = divmod(args.episodes, shards)
        clients, first = [], args.seed
        for i in range(shards):
            count = per_shard + (i < remainder)
            logs.append(open(out / "logs" / f"client-{i:02d}.log", "w"))
            clients.append(
                subprocess.Popen(
                    [
                        "bun",
                        "src/app/cli/main.ts",
                        "collect" if args.record else "evaluate",
                        "--policy",
                        f"ws://127.0.0.1:{args.port + i}/policy",
                        *TASK,
                        "--seed",
                        str(first),
                        "--episodes",
                        str(count),
                        "--out",
                        str(out / f"shard-{i:02d}"),
                    ],
                    cwd=REPO,
                    stdout=logs[-1],
                    stderr=subprocess.STDOUT,
                )
            )
            first += count
        start = time.time()
        while any(c.poll() is None for c in clients):
            time.sleep(15)
            done = len(summarize(out)["results"])
            print(
                f"[evaluate] {done}/{args.episodes} episodes, {time.time() - start:.0f}s", file=sys.stderr, flush=True
            )
        failed = [i for i, c in enumerate(clients) if c.returncode != 0]
    finally:
        for server in servers:
            server.terminate()
        for file in logs:
            file.close()
    summary = summarize(out)
    summary["failedShards"] = failed
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"out": str(out)} | {k: v for k, v in summary.items() if k != "results"}))
    if failed or summary["episodes"] != args.episodes:
        sys.exit(1)


if __name__ == "__main__":
    main()
