"""Measure warmed end-to-end MLX planning latency; emit JSON on stdout."""

import argparse
import json
import os
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
from PIL import Image

from stackling_vla.mlx_serve import MlxVlaPolicy

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--checkpoint", type=Path, required=True)
parser.add_argument("--base", type=Path, required=True)
parser.add_argument("--bits", type=int, choices=(0, 4, 8), default=0)
parser.add_argument("--samples", type=int, default=3)
parser.add_argument("--flow-steps", type=int, default=2)
parser.add_argument("--repeats", type=int, default=20)
parser.add_argument("--seed", type=int, default=42)
parser.add_argument("--image", type=Path, help="A sensor RGB frame at the training resolution")
args = parser.parse_args()
if min(args.samples, args.flow_steps, args.repeats) < 1:
    parser.error("samples, flow-steps and repeats must be positive")
os.environ["STACKLING_VLA_BASE"] = str(args.base)
os.environ["STACKLING_VLA_BITS"] = str(args.bits)
started = time.perf_counter()
policy = MlxVlaPolicy(args.checkpoint, 8, args.flow_steps, 1.0, args.samples)
load_and_warmup_seconds = time.perf_counter() - started
shape = (policy.config.image_height, policy.config.image_width, 3)
frame = (
    np.asarray(Image.open(args.image).convert("RGB"))
    if args.image
    else np.random.default_rng(args.seed).integers(0, 256, shape, dtype=np.uint8)
)
if frame.shape != shape:
    parser.error(f"image shape must be {shape}; got {frame.shape}")
state = np.zeros((1 + len(policy.config.history), 16), np.float32)
mx.random.seed(args.seed)
policy.sample(frame, state)
latencies = []
for _ in range(args.repeats):
    started = time.perf_counter()
    output = policy.sample(frame, state)
    latencies.append((time.perf_counter() - started) * 1000)
    if not np.isfinite(output).all():
        raise ValueError("Model produced non-finite actions")
print(
    json.dumps(
        {
            "checkpoint": str(args.checkpoint.resolve()),
            "base": str(args.base.resolve()),
            "bits": args.bits,
            "samples": args.samples,
            "flowSteps": args.flow_steps,
            "seed": args.seed,
            "input": str(args.image.resolve()) if args.image else "synthetic RGB; zero measured state",
            "device": str(mx.default_device()),
            "loadAndWarmupSeconds": load_and_warmup_seconds,
            "latencyMs": {
                "median": float(np.median(latencies)),
                "p95": float(np.percentile(latencies, 95)),
                "min": min(latencies),
                "max": max(latencies),
                "samples": latencies,
            },
            "peakAllocatedBytesIncludingLoad": mx.get_peak_memory(),
            "finite": True,
        },
        indent=2,
    )
)
