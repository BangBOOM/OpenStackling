"""Action and state encoding shared by training and serving.

A chunk holds the next ``H`` control-rate targets after one observation. Joint
targets are encoded relative to the measured state at that observation and
scaled per horizon step, so near-term steps keep fine resolution. Gripper gaps
stay absolute. The teacher's continuous-tracking flag is the last channel.
"""

import numpy as np

STATE_DIM = 16
ACTION_DIM = 16
GAPS = [8, 15]
JOINTS = [i for i in range(ACTION_DIM) if i not in GAPS]
CHANNELS = ACTION_DIM + 1  # sixteen targets and the tracking flag
# Below this, joint motion is tracking jitter; a smaller scale would spend the
# loss on noise at the first horizon steps.
MIN_JOINT_SCALE = 0.01


def chunk_rows(anchor_rows: np.ndarray, horizon: int, last_row: int) -> np.ndarray:
    """Action rows for each anchor; rows past the episode end repeat the final target."""
    return np.minimum(anchor_rows[:, None] + np.arange(horizon)[None], last_row)


def compute_stats(states: np.ndarray, deltas: np.ndarray, gaps: np.ndarray) -> dict:
    """states (N,16); deltas (N,H,14) joint target minus anchor state; gaps (N,H,2)."""
    rms = np.sqrt((deltas.astype(np.float64) ** 2).mean(axis=(0, 2)))
    return {
        "state_mean": states.mean(0).tolist(),
        "state_std": np.maximum(states.std(0), 1e-3).tolist(),
        "joint_scale": np.maximum(rms, MIN_JOINT_SCALE).tolist(),
        "gap_mean": float(gaps.mean()),
        "gap_std": float(gaps.std()),
    }


class Codec:
    def __init__(self, stats: dict):
        self.stats = stats
        self.state_mean = np.asarray(stats["state_mean"], np.float32)
        self.state_std = np.asarray(stats["state_std"], np.float32)
        self.joint_scale = np.asarray(stats["joint_scale"], np.float32)[:, None]
        self.gap_mean = np.float32(stats["gap_mean"])
        self.gap_std = np.float32(stats["gap_std"])
        self.horizon = len(stats["joint_scale"])

    def state(self, state: np.ndarray) -> np.ndarray:
        return ((state - self.state_mean) / self.state_std).astype(np.float32)

    def encode(self, actions: np.ndarray, continuous: np.ndarray, state: np.ndarray) -> np.ndarray:
        """actions (H,16) absolute, continuous (H,) bool, state (16,) -> (H,17)."""
        out = np.empty((self.horizon, CHANNELS), np.float32)
        out[:, JOINTS] = (actions[:, JOINTS] - state[JOINTS]) / self.joint_scale
        out[:, GAPS] = (actions[:, GAPS] - self.gap_mean) / self.gap_std
        out[:, ACTION_DIM] = np.where(continuous, 1.0, -1.0)
        return out

    def decode(self, encoded: np.ndarray, state: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """(H,17) -> absolute float64 targets (H,16) and tracking flags (H,)."""
        encoded = encoded.astype(np.float64)
        actions = np.empty((self.horizon, ACTION_DIM), np.float64)
        actions[:, JOINTS] = state[JOINTS] + encoded[:, JOINTS] * self.joint_scale
        actions[:, GAPS] = encoded[:, GAPS] * self.gap_std + self.gap_mean
        return actions, encoded[:, ACTION_DIM] > 0
