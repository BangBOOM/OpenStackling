"""Collection configs whose start layouts resemble what a policy leaves behind.

    python -m stackling_vla.layouts --out DIR --shards 300 [--seed 0]

The default layouts hold axis-aligned cubes with gripper clearance between
them. A cube that a policy has moved is usually turned about the vertical and
may lie next to the other one, and an attempt that starts there (see
``serve.ChunkPolicy``) needs demonstrations from such layouts. Each shard gets
one config, DIR/shard-NNN.json, for ``scripts/collect.sh`` (CONFIGS=DIR): fixed
cube yaws, optionally no clearance, and either a slightly enlarged working
region or a small box inside it that forces the cubes close together. Cube
positions still follow the episode seed.
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np

REGION = [-0.40, 0.40, -0.28, 0.16]  # x and z bounds on the table, metres
CAMERA = json.loads((Path(__file__).parents[2] / "configs" / "head-camera.json").read_text())["camera"]


def cube(index: int, color: str, yaw: float) -> dict:
    return {
        "id": f"object-{index}",
        "shape": {"kind": "cuboid", "size": [0.05, 0.05, 0.05]},
        "color": color,
        "rotation": {"x": 0, "y": math.sin(yaw / 2), "z": 0, "w": math.cos(yaw / 2)},
        "density": 120,
        "friction": 0.8,
    }


def layout(rng: np.random.Generator) -> dict:
    yaws = [0.0 if rng.random() < 0.25 else float(rng.uniform(0, math.pi / 2)) for _ in range(2)]
    region, clearance = REGION, bool(rng.random() < 0.5)
    if rng.random() < 0.5:
        width, depth = rng.uniform(0.16, 0.30), rng.uniform(0.14, 0.22)
        x = rng.uniform(REGION[0], REGION[1] - width)
        z = rng.uniform(REGION[2], REGION[3] - depth)
        region, clearance = [round(float(v), 3) for v in (x, x + width, z, z + depth)], False
    scene = {"region": region, "clearance": clearance, "objects": [cube(0, "red", yaws[0]), cube(1, "yellow", yaws[1])]}
    return {"camera": CAMERA, "scene": scene}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True)
    rng = np.random.default_rng(args.seed)
    for shard in range(args.shards):
        (out / f"shard-{shard:03d}.json").write_text(json.dumps(layout(rng), indent=2) + "\n")


if __name__ == "__main__":
    main()
