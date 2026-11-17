from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np
from numpy.typing import NDArray


@dataclass(frozen=True)
class TaskContext:
    prompt: str
    language: str
    control_seconds: float


@dataclass(frozen=True)
class EpisodeContext:
    episode_id: str
    seed: int
    config: dict[str, Any]
    calibration: dict[str, Any]
    task: TaskContext


@dataclass(frozen=True)
class Observation:
    observation_id: int
    tick: int
    time: float
    state: tuple[float, ...]
    rgb: NDArray[np.uint8]
    depth: NDArray[np.uint16] | None
    camera_to_world: NDArray[np.float64]


@dataclass(frozen=True)
class ControlContext:
    tick: int
    dt: float
    observation_id: int


@dataclass(frozen=True)
class EpisodeSummary:
    outcome: str
    reason: str
    ticks: int
    seconds: float


@dataclass(frozen=True)
class ActionTarget:
    action: list[float]
    continuous: bool = False


class Policy(Protocol):
    def reset(self, context: EpisodeContext) -> None: ...
    def observe(self, observation: Observation) -> None: ...
    def act(self, context: ControlContext) -> ActionTarget: ...
    def end(self, summary: EpisodeSummary) -> None: ...
