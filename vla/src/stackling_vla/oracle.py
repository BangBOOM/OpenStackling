"""Diagnostic policy: replay recorded teacher chunks through the serving path.

It looks up the recorded episode by scene seed, encodes each chunk against the
recorded state and lets the shared executor decode it against the live state.
Without noise this validates the codec and chunk timing; with noise it measures
how much action error the task tolerates. It predicts nothing from images.

Environment: STACKLING_VLA_INDEX (prepared index), STACKLING_VLA_EXECUTE,
STACKLING_VLA_NOISE_BIAS (rad, one random joint offset per chunk),
STACKLING_VLA_NOISE_IID (rad, independent per target), STACKLING_VLA_DUMP
(directory receiving the live frames of each episode as frames-SEED.npy).
"""

import json
import os
from pathlib import Path

import numpy as np

from .codec import JOINTS, Codec, chunk_rows
from .serve import ChunkPolicy


class OraclePolicy(ChunkPolicy):
    def __init__(self, index: str, execute: int, bias: float, iid: float, dump: str | None):
        root = Path(index)
        self.meta = json.loads((root / "meta.json").read_text())
        with np.load(root / "index.npz") as z:
            self.index = {k: z[k] for k in z.files}
        self.bias = bias
        self.iid = iid
        self.dump = Path(dump) if dump else None
        self.random = np.random.default_rng(0)
        super().__init__(Codec(self.meta["stats"]), execute)

    def start(self, context) -> None:
        self.episode = int(np.flatnonzero(self.index["seeds"] == context.seed)[0])
        self.seed = context.seed
        self.period = context.config["environment"]["physicsHz"] // context.config["run"]["observationHz"]
        self.frames = []

    def observe(self, observation) -> None:
        super().observe(observation)
        if self.dump:
            self.frames.append(observation.rgb)

    def plan(self, observation) -> np.ndarray:
        x, e = self.index, self.episode
        count = x["obs_offsets"][e + 1] - x["obs_offsets"][e]
        j = min(observation.tick // self.period, count - 1)
        state = x["states"][x["obs_offsets"][e] + j]
        first, end = x["act_offsets"][e], x["act_offsets"][e + 1]
        rows = first + chunk_rows(np.array([j * self.meta["stride"]]), self.codec.horizon, end - first - 1)[0]
        encoded = self.codec.encode(x["actions"][rows], x["continuous"][rows], state)
        noise = self.random.normal(0, self.bias, len(JOINTS)) + self.random.normal(
            0, self.iid, (self.codec.horizon, len(JOINTS))
        )
        encoded[:, JOINTS] += (noise / self.codec.joint_scale).astype(np.float32)
        return encoded

    def end(self, summary) -> None:
        super().end(summary)
        if self.dump:
            self.dump.mkdir(parents=True, exist_ok=True)
            np.save(self.dump / f"frames-{self.seed}.npy", np.stack(self.frames))


def create() -> OraclePolicy:
    return OraclePolicy(
        os.environ["STACKLING_VLA_INDEX"],
        int(os.environ.get("STACKLING_VLA_EXECUTE", "8")),
        float(os.environ.get("STACKLING_VLA_NOISE_BIAS", "0")),
        float(os.environ.get("STACKLING_VLA_NOISE_IID", "0")),
        os.environ.get("STACKLING_VLA_DUMP"),
    )
