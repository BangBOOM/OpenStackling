"""Apple Silicon policy factory; shares chunk execution with CUDA serving."""

import logging
import time

import mlx.core as mx
import numpy as np

from .codec import CHANNELS
from .mlx_model import load_model
from .serve import VlaPolicy
from .serve import create as create_policy

log = logging.getLogger("uvicorn.error")


class MlxVlaPolicy(VlaPolicy):
    load_model = staticmethod(load_model)

    def sample(self, rgb: np.ndarray, state: np.ndarray, prompt: int = 0, anchor: np.ndarray | None = None):
        started = time.perf_counter()
        frame = mx.array(rgb)
        first = mx.array(rgb if anchor is None else anchor) if self.config.anchor else None
        normalized = mx.array(self.codec.state(np.asarray(state, np.float32)))[None]
        noise = self.noise_scale * mx.random.normal((self.samples, self.config.horizon, CHANNELS))
        chunks = self.model.sample(frame, prompt, normalized, self.flow_steps, noise, first)
        flat = chunks.reshape(self.samples, -1)
        distances = mx.sqrt(mx.sum((flat[:, None] - flat[None]) ** 2, axis=-1))
        selected = chunks[mx.argmin(distances.sum(axis=1))]
        result = np.asarray(selected)
        log.info("MLX plan: %.3f s, peak %.2f GB", time.perf_counter() - started, mx.get_peak_memory() / 1e9)
        return result


def create() -> MlxVlaPolicy:
    return create_policy(MlxVlaPolicy)
