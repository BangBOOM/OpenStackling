"""Pack recorded shards into one training index.

    python -m stackling_vla.prepare --data ROOT [ROOT ...] --out DIR [--horizon 32] [--max-seconds S]

Takes successful episodes of the teacher or of a served policy and reads only
model-visible fields (measured states, executed targets, tracking flags, prompt,
video). ``--max-seconds`` drops slower episodes, e.g. policy runs that wandered. Output: index.npz (concatenated arrays and offsets),
videos.bin (all mp4 files back to back), meta.json (prompts, runtime contract,
normalization statistics).
"""

import argparse
import hashlib
import io
import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import av
import numpy as np

from .codec import GAPS, JOINTS, chunk_rows, compute_stats

VAL_PERCENT = 2


def complete_video(video: bytes, frames: int, rate: int) -> bool:
    """Whether the container holds one packet per observation.

    Recordings made under heavy load occasionally lack a few packets; a missing
    keyframe then makes the rest of its group undecodable.
    """
    with av.open(io.BytesIO(video)) as container:
        stream = container.streams.video[0]
        indices = [round(float(p.pts * stream.time_base) * rate) for p in container.demux(stream) if p.pts is not None]
    return indices == list(range(frames))


def read_episode(directory: Path, max_seconds: float):
    metadata = json.loads((directory / "metadata.json").read_text())
    if metadata["kind"] != "dataset" or metadata["schemaVersion"] != 10:
        raise ValueError(f"{directory}: expected dataset schema 10")
    if metadata["result"]["outcome"] != "success" or metadata["result"]["seconds"] > max_seconds:
        return "failed"
    config = metadata["config"]
    physics_hz = config["environment"]["physicsHz"]
    obs_period = physics_hz // config["run"]["observationHz"]
    act_period = physics_hz // config["run"]["controlHz"]
    with np.load(directory / "data.npz") as z:
        states = z["obs.state"].astype(np.float32)
        actions = z["act.executed"].astype(np.float32)
        continuous = z["act.continuous"].astype(bool)
        if not (
            (z["obs.tick"] == np.arange(len(states)) * obs_period).all()
            and (z["act.tick"] == np.arange(len(actions)) * act_period).all()
        ):
            raise ValueError(f"{directory}: unexpected clocks")
    contract = {
        "camera": config["camera"],
        "environment": config["environment"]["version"],
        "physicsHz": physics_hz,
        "controlHz": config["run"]["controlHz"],
        "observationHz": config["run"]["observationHz"],
        "fingerprint": metadata["provenance"]["environmentFingerprint"],
    }
    video = (directory / "video.mp4").read_bytes()
    if not complete_video(video, len(states), config["run"]["observationHz"]):
        return "video"
    return {
        "seed": config["run"]["seed"],
        "prompt": metadata["result"]["task"]["prompt"]["text"],
        "contract": contract,
        "states": states,
        "actions": actions,
        "continuous": continuous,
        "video": video,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", nargs="+", required=True, help="directories containing shard datasets")
    parser.add_argument("--out", required=True)
    parser.add_argument("--horizon", type=int, default=32)
    parser.add_argument("--workers", type=int, default=64)
    parser.add_argument("--max-seconds", type=float, default=float("inf"))
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True)
    directories = sorted(d for root in args.data for d in Path(root).glob("**/episodes/[0-9]*") if d.is_dir())
    with ProcessPoolExecutor(args.workers) as pool:
        results = list(pool.map(read_episode, directories, [args.max_seconds] * len(directories), chunksize=16))
    episodes = [e for e in results if isinstance(e, dict)]
    contract = episodes[0]["contract"]
    if any(e["contract"] != contract for e in episodes):
        raise ValueError("Episodes were recorded under different runtime contracts")
    stride = contract["controlHz"] // contract["observationHz"]
    prompts = sorted({e["prompt"] for e in episodes})
    val = np.array(
        [int(hashlib.sha256(str(e["seed"]).encode()).hexdigest()[:8], 16) % 100 < VAL_PERCENT for e in episodes]
    )
    with open(out / "videos.bin", "wb") as f:
        for e in episodes:
            f.write(e["video"])

    def offsets(key):
        return np.concatenate([[0], np.cumsum([len(e[key]) for e in episodes])])

    states = np.concatenate([e["states"] for e in episodes])
    actions = np.concatenate([e["actions"] for e in episodes])
    np.savez(
        out / "index.npz",
        states=states,
        actions=actions,
        continuous=np.concatenate([e["continuous"] for e in episodes]),
        obs_offsets=offsets("states"),
        act_offsets=offsets("actions"),
        video_offsets=offsets("video"),
        seeds=np.array([e["seed"] for e in episodes]),
        prompts=np.array([prompts.index(e["prompt"]) for e in episodes]),
        val=val,
    )
    # Statistics over training anchors only.
    deltas, gaps, anchor_states = [], [], []
    for i, e in enumerate(episodes):
        if val[i]:
            continue
        rows = chunk_rows(np.arange(len(e["states"])) * stride, args.horizon, len(e["actions"]) - 1)
        chunk = e["actions"][rows]
        deltas.append(chunk[:, :, JOINTS] - e["states"][:, None, JOINTS])
        gaps.append(chunk[:, :, GAPS])
        anchor_states.append(e["states"])
    stats = compute_stats(np.concatenate(anchor_states), np.concatenate(deltas), np.concatenate(gaps))
    meta = {
        "contract": contract,
        "prompts": prompts,
        "horizon": args.horizon,
        "stride": stride,
        "stats": stats,
        "episodes": len(episodes),
        "skippedFailed": results.count("failed"),
        "skippedIncompleteVideo": results.count("video"),
        "validationEpisodes": int(val.sum()),
        "observations": int(len(states)),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    keys = ("episodes", "skippedFailed", "skippedIncompleteVideo", "validationEpisodes", "observations")
    print(json.dumps({k: meta[k] for k in keys}))


if __name__ == "__main__":
    main()
