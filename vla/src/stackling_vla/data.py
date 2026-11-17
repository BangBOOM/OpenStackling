"""Training samples: one observation frame, its measured state and the encoded action chunk."""

import io
import json
from pathlib import Path

import av
import numpy as np
import torch
from torch.utils.data import Dataset

from .codec import JOINTS, Codec, chunk_rows


def decode_frame(video: bytes | memoryview, index: int, rate: int) -> np.ndarray:
    """Frame ``index`` of an episode video as RGB uint8 [H,W,3]; frame i is observation i."""
    with av.open(io.BytesIO(video)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "NONE"
        container.seek(int(index / rate / stream.time_base), stream=stream, backward=True)
        for frame in container.decode(stream):
            if round(float(frame.pts * stream.time_base) * rate) == index:
                return frame.to_ndarray(format="rgb24")
    raise ValueError(f"Video has no frame {index}")


class WindowDataset(Dataset):
    def __init__(
        self,
        root: str | Path,
        split: str,
        stats: dict | None = None,
        anchor: bool = False,
        state_noise: float = 0.0,
        history: tuple = (),
    ):
        """``stats`` replaces the index statistics when continuing a model trained on another index.

        ``anchor`` adds the episode's first frame to every item. ``state_noise`` (radians) shifts the
        measured joint state of an item; its targets stay absolute, so their encoding leads back to them.
        ``history`` appends the states measured that many observations earlier (the first state before the start).
        """
        root = Path(root)
        self.anchor = anchor
        self.state_noise = state_noise
        self.history = history
        self.meta = json.loads((root / "meta.json").read_text())
        self.codec = Codec(stats or self.meta["stats"])
        self.rate = self.meta["contract"]["observationHz"]
        self.stride = self.meta["stride"]
        with np.load(root / "index.npz") as z:
            self.index = {k: z[k] for k in z.files}
        self.videos = np.memmap(root / "videos.bin", dtype=np.uint8, mode="r")
        chosen = np.flatnonzero(self.index["val"] == (split == "val"))
        obs = self.index["obs_offsets"]
        # One anchor per observation: (episode, observation index within the episode).
        self.anchors = np.concatenate(
            [np.stack([np.full(obs[e + 1] - obs[e], e), np.arange(obs[e + 1] - obs[e])], 1) for e in chosen]
        )

    def __len__(self):
        return len(self.anchors)

    def episode_seconds(self) -> np.ndarray:
        """Duration of the episode each anchor belongs to."""
        obs = self.index["obs_offsets"]
        return (obs[1:] - obs[:-1])[self.anchors[:, 0]] / self.rate

    def __getitem__(self, i):
        episode, j = self.anchors[i]
        x = self.index
        state = x["states"][x["obs_offsets"][episode] + j]
        first, end = x["act_offsets"][episode], x["act_offsets"][episode + 1]
        rows = first + chunk_rows(np.array([j * self.stride]), self.codec.horizon, end - first - 1)[0]
        video = memoryview(self.videos[x["video_offsets"][episode] : x["video_offsets"][episode + 1]])
        if self.state_noise:
            state = state.copy()
            state[JOINTS] += self.state_noise * torch.randn(len(JOINTS)).numpy()
        base = x["obs_offsets"][episode]
        states = np.stack([state, *(x["states"][base + max(j - lag, 0)] for lag in self.history)])
        item = {
            "frame": torch.from_numpy(decode_frame(video, int(j), self.rate)),
            "state": torch.from_numpy(self.codec.state(states if self.history else state)),
            "actions": torch.from_numpy(self.codec.encode(x["actions"][rows], x["continuous"][rows], state)),
            "prompt": int(x["prompts"][episode]),
        }
        if self.anchor:
            item["anchor"] = torch.from_numpy(decode_frame(video, 0, self.rate))
        return item
