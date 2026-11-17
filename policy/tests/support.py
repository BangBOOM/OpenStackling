"""Fault injection policies used by the cross-language acceptance test."""

import hashlib
import json
import os
import time

from stackling_policy.interfaces import (
    ActionTarget,
    ControlContext,
    EpisodeContext,
    EpisodeSummary,
    Observation,
)


class Hold:
    """Trivial base policy: hold the first measured state; never plan a stack."""

    def reset(self, context: EpisodeContext) -> None:
        self.state = None

    def observe(self, observation: Observation) -> None:
        if self.state is None:
            self.state = list(observation.state)

    def act(self, context: ControlContext) -> ActionTarget:
        if self.state is None:
            raise RuntimeError("Initial observation required")
        return ActionTarget(list(self.state))

    def end(self, summary: EpisodeSummary) -> None:
        self.state = None


class Probe(Hold):
    def reset(self, context):
        assert set(context.config) == {"environment", "camera", "run"}
        assert not hasattr(context, "snapshot")
        if os.environ.get("POLICY_TEST_MODE") == "reset-error":
            raise RuntimeError("Injected reset failure")
        if os.environ.get("POLICY_TEST_MODE") == "reset-slow":
            time.sleep(0.4)
        super().reset(context)
        self.trace = {
            "prompt": context.task.prompt,
            "seed": context.seed,
            "observations": [],
            "actions": [],
        }

    def observe(self, observation):
        assert observation.rgb.dtype.name == "uint8" and observation.rgb.shape[2] == 3
        assert set(vars(observation)) == {
            "observation_id",
            "tick",
            "time",
            "state",
            "rgb",
            "depth",
            "camera_to_world",
        }
        if observation.depth is not None:
            assert observation.depth.dtype.name == "uint16"
            assert observation.depth.shape == observation.rgb.shape[:2]
        if os.environ.get("POLICY_TEST_TRACE"):
            self.trace["observations"].append(
                {
                    "tick": observation.tick,
                    "state": list(observation.state),
                    "rgb": hashlib.sha256(observation.rgb.tobytes()).hexdigest(),
                    "camera_to_world": observation.camera_to_world.tolist(),
                    "depth": hashlib.sha256(observation.depth.tobytes()).hexdigest()
                    if observation.depth is not None
                    else None,
                }
            )
        super().observe(observation)

    def act(self, context):
        mode = os.environ.get("POLICY_TEST_MODE")
        if mode == "slow":
            time.sleep(0.4)
        if mode == "invalid":
            return ActionTarget([999.0] * 16)
        if mode == "model-error":
            raise RuntimeError("Injected model error")
        action = super().act(context)
        if mode == "head-motion":
            action.action[0] = 0.15
            action.action[1] = 0.08
            action = ActionTarget(action.action, True)
        if os.environ.get("POLICY_TEST_TRACE"):
            self.trace["actions"].append(
                {
                    "tick": context.tick,
                    "action": action.action,
                    "continuous": action.continuous,
                }
            )
        return action

    def end(self, summary):
        assert set(vars(summary)) == {"outcome", "reason", "ticks", "seconds"}
        if trace_path := os.environ.get("POLICY_TEST_TRACE"):
            with open(trace_path, "a") as trace_file:
                trace_file.write(json.dumps(self.trace) + "\n")
        super().end(summary)


def create():
    return Probe()
