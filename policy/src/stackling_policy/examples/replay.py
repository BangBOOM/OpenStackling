"""Demo only: consume live frames and play recorded absolute targets by tick."""

import hashlib
import io
import json
import logging
import os
from pathlib import Path

import numpy as np

from stackling_policy.contract import validate_action
from stackling_policy.interfaces import (
    ActionTarget,
    ControlContext,
    EpisodeContext,
    EpisodeSummary,
    Observation,
)

log = logging.getLogger("uvicorn.error")


class Replay:
    def __init__(self, episode: Path):
        metadata = json.loads((episode / "metadata.json").read_text())
        if metadata.get("kind") != "dataset" or metadata["schemaVersion"] != 10:
            raise ValueError("Expected a dataset recording with schema version 10")
        self.config = metadata["config"]
        self.config.pop("teacher")
        self.config.pop("appearance")
        self.recorded_seed = self.config["run"].pop("seed")
        data = (episode / "data.npz").read_bytes()
        if hashlib.sha256(data).hexdigest() != metadata["files"]["data.npz"]:
            raise ValueError("Recorded action checksum mismatch")
        with np.load(io.BytesIO(data)) as z:
            period = (
                self.config["environment"]["physicsHz"]
                // self.config["run"]["controlHz"]
            )
            ticks = z["act.tick"]
            continuous = z["act.continuous"]
            if not len(ticks) or any(ticks[i] != i * period for i in range(len(ticks))):
                raise ValueError("Demo requires regular, absolute teacher targets")
            self.period = period
            self.continuous = [bool(value) for value in continuous]
            self.actions = [row.tolist() for row in z["act.executed"]]
            for action in self.actions:
                validate_action(action, self.config)

    def reset(self, context: EpisodeContext) -> None:
        public = {k: v for k, v in self.config.items() if k not in {"scene", "task"}}
        public["run"] = {
            k: v
            for k, v in public["run"].items()
            if k not in {"maxSeconds", "cameraSeed"}
        }
        if context.config != public:
            raise ValueError("Demo recording and service Profile differ")
        # Seed is deliberately user-controlled; mismatches are not rejected.
        self.frames = 0
        self.latest_observation_id = None
        self.next_tick = 0
        self.frame_digest = hashlib.sha256()
        self.rgb_mean = None
        self.last_state = None
        log.info(
            "Replay Demo: scene seed %s, recorded seed %s",
            context.seed,
            self.recorded_seed,
        )

    def observe(self, observation: Observation) -> None:
        self.frames += 1
        self.latest_observation_id = observation.observation_id
        self.last_state = observation.state
        self.rgb_mean = observation.rgb.mean(axis=(0, 1)).tolist()
        self.frame_digest.update(observation.rgb.tobytes())
        if observation.depth is not None:
            self.frame_digest.update(observation.depth.tobytes())
        if self.frames == 1 or self.frames % 100 == 0:
            log.info(
                "Replay Demo: frames=%s tick=%s RGB=%s mean=%s",
                self.frames,
                observation.tick,
                observation.rgb.shape,
                self.rgb_mean,
            )

    def act(self, context: ControlContext) -> ActionTarget:
        if (
            self.latest_observation_id is None
            or context.observation_id != self.latest_observation_id
        ):
            raise ValueError("Latest live observation required")
        if context.tick != self.next_tick:
            raise ValueError("Unexpected control tick")
        self.next_tick += self.period
        # Continue holding the final target until the independent scorer ends the task.
        index = min(context.tick // self.period, len(self.actions) - 1)
        return ActionTarget(list(self.actions[index]), self.continuous[index])

    def end(self, summary: EpisodeSummary) -> None:
        log.info(
            "Replay Demo ended: outcome=%s frames=%s frame_sha256=%s",
            summary.outcome,
            self.frames,
            self.frame_digest.hexdigest(),
        )
        self.latest_observation_id = None
        self.last_state = None


def create() -> Replay:
    return Replay(Path(os.environ["STACKLING_REPLAY_EPISODE"]))
