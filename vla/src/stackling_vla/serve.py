"""Policy-service adapter for a trained checkpoint.

    STACKLING_VLA_CHECKPOINT=RUN/step-020000 stackling-policy serve \
        --profile PROFILE --factory stackling_vla.serve:create \
        --policy-id stackling-vla --model-revision NAME

STACKLING_VLA_EXECUTE (default 8) is the number of control ticks executed
before the chunk is planned again; STACKLING_VLA_FLOW_STEPS (default 10) is the
number of integration steps; STACKLING_VLA_NOISE_SCALE (default 1) scales the
initial noise, trading sample diversity for repeatability. STACKLING_VLA_SAMPLES
(default 1) draws that many chunks per plan and executes their medoid, the draw
closest to all others, so a plan follows the majority among alternative motions.
STACKLING_VLA_ATTEMPT (seconds, default 0 = off) turns the episode into attempts
that each start from the initial posture, see ``ChunkPolicy``.
Device selection follows CUDA_VISIBLE_DEVICES.
"""

import json
import logging
import os
from pathlib import Path

import numpy as np
from stackling_policy.interfaces import ActionTarget

from .codec import CHANNELS, GAPS, JOINTS, Codec

log = logging.getLogger("uvicorn.error")

OPEN, CLOSED = 0.065, 0.055  # gripper gap targets in metres counted as open and as closed
HELD = 30  # control ticks a gripper stays closed while it carries something
CLEAR = 40  # control ticks the policy keeps moving after a release, to lift the hand off the cube


class ChunkPolicy:
    """Executes encoded chunks; subclasses supply ``start`` and ``plan``.

    A new chunk is planned on a control tick that carries a fresh observation,
    once ``execute`` targets of the current chunk have been issued. This is the
    alignment the training samples use: chunk entry 0 belongs to the control
    tick of its observation.

    With ``attempt`` seconds set, the episode becomes a series of attempts. An
    attempt ends when a gripper that carried something opens, or after
    ``attempt`` seconds. The robot then returns to its initial posture and the
    policy starts over as if the episode had just begun. Demonstrations always
    start from that posture, so every attempt meets a situation they cover: the
    second transfer of a relocated cube and the retry after a miss alike. Only
    the policy's own targets and the measured joint state drive this.
    """

    def __init__(self, codec: Codec, execute: int, attempt: float = 0.0):
        if not 0 < execute <= codec.horizon:
            raise ValueError("Execute horizon must lie within the chunk")
        self.codec = codec
        self.execute = execute
        self.attempt = attempt

    def reset(self, context) -> None:
        robot = context.config["environment"]["robot"]
        body = robot["body"]
        limits = np.array(
            [
                [-body["yawLimit"], body["yawLimit"]],
                [0, body["pitchLimit"]],
                *robot["limits"],
                robot["gap"],
                *robot["limits"],
                robot["gap"],
            ],
            np.float64,
        )
        self.low, self.high = limits[:, 0], limits[:, 1]
        self.observation = None
        self.chunk = None
        self.cursor = 0
        self.plans = 0
        self.clipped = 0.0
        self.attempt_ticks = round(self.attempt * context.config["run"]["controlHz"])
        self.home = None
        self.attempts = 0
        self.begin()
        self.start(context)

    def begin(self) -> None:
        self.mode = "policy"  # then "clear" after a release, then "home"
        self.ticks = 0
        self.opened = [False, False]
        self.closed = [0, 0]
        self.forced = []
        self.settled = 0
        self.attempts += 1

    def observe(self, observation) -> None:
        self.observation = observation

    def restart(self) -> None:
        """Forget what belongs to the finished attempt."""

    def supervise(self, action: list) -> list:
        """Follow the attempt through its release; returns the target to issue."""
        self.ticks += 1
        released = []
        for g, channel in enumerate(GAPS):
            if action[channel] > OPEN:
                if self.closed[g] >= HELD:
                    released.append(g)
                self.opened[g], self.closed[g] = True, 0
            elif action[channel] < CLOSED and self.opened[g]:
                self.closed[g] += 1
        if self.mode == "policy" and (released or self.ticks > self.attempt_ticks):
            self.mode, self.left = "clear", CLEAR
            self.forced = released or [0, 1]
        if self.mode == "clear":
            for g in self.forced:
                action[GAPS[g]] = float(self.high[GAPS[g]])
            self.left -= 1
            if self.left == 0:
                self.mode = "home"
        return action

    def at_home(self) -> bool:
        state = np.asarray(self.observation.state, np.float64)
        near = np.abs(state - self.home)
        self.settled = self.settled + 1 if near[JOINTS].max() < 0.01 and near[GAPS].max() < 0.002 else 0
        return self.settled >= 3

    def act(self, context) -> ActionTarget:
        fresh = self.observation.tick == context.tick
        if self.home is None:
            self.home = np.asarray(self.observation.state, np.float64)
        if self.mode == "home":
            if not (fresh and self.at_home()):
                return ActionTarget(self.home.tolist(), False)
            self.chunk = None
            self.begin()
            self.restart()
        if self.chunk is None or self.cursor >= self.codec.horizon or (self.cursor >= self.execute and fresh):
            state = np.asarray(self.observation.state, np.float64)
            actions, continuous = self.codec.decode(self.plan(self.observation), state)
            bounded = np.clip(actions, self.low, self.high)
            self.clipped = max(self.clipped, float(np.abs(bounded - actions).max()))
            self.chunk = (bounded, continuous)
            self.cursor = 0
            self.plans += 1
        i = self.cursor
        self.cursor += 1
        action = self.chunk[0][i].tolist()
        return ActionTarget(self.supervise(action) if self.attempt_ticks else action, bool(self.chunk[1][i]))

    def end(self, summary) -> None:
        log.info(
            "episode %s: %.1f s, %d plans, %d attempts, largest limit violation %.4f",
            summary.outcome,
            summary.seconds,
            self.plans,
            self.attempts,
            self.clipped,
        )
        self.observation = None
        self.chunk = None


def load_model(checkpoint: str | Path):
    import torch
    from safetensors.torch import load_file

    from .model import VLA, VLAConfig

    checkpoint = Path(checkpoint)
    config = json.loads((checkpoint / "config.json").read_text())
    # The checkpoint names the pretrained model it was trained from by path; another host may keep it elsewhere.
    config["base"] = os.environ.get("STACKLING_VLA_BASE", config["base"])
    model = VLA(VLAConfig(**config))
    missing, unexpected = model.load_state_dict(load_file(checkpoint / "model.safetensors"), strict=False)
    if unexpected or any(not k.startswith("backbone.llm.embed_tokens.") for k in missing):
        raise ValueError(f"Checkpoint does not match the model: {missing} {unexpected}")
    # Half-width backbone weights: several services share one GPU during evaluation.
    model.backbone.to(torch.bfloat16)
    return model.cuda().eval()


class VlaPolicy(ChunkPolicy):
    load_model = staticmethod(load_model)

    def __init__(
        self, checkpoint: str, execute: int, flow_steps: int, noise_scale: float, samples: int, attempt: float = 0.0
    ):
        self.model = self.load_model(checkpoint)
        self.config = self.model.config
        self.flow_steps = flow_steps
        self.noise_scale = noise_scale
        self.samples = samples
        super().__init__(Codec(self.config.stats), execute, attempt)
        blank = np.zeros((self.config.image_height, self.config.image_width, 3), np.uint8)
        self.sample(blank, np.zeros((1 + len(self.config.history), 16)))

    def sample(self, rgb: np.ndarray, state: np.ndarray, prompt: int = 0, anchor: np.ndarray | None = None):
        import torch

        frame = torch.from_numpy(rgb).cuda()[None]
        first = torch.from_numpy(rgb if anchor is None else anchor).cuda()[None] if self.config.anchor else None
        normalized = torch.from_numpy(self.codec.state(np.asarray(state, np.float32))).cuda()[None]
        noise = self.noise_scale * torch.randn(self.samples, self.config.horizon, CHANNELS, device="cuda")
        with torch.autocast("cuda", torch.bfloat16):
            chunks = self.model.sample(
                frame, torch.tensor([prompt], device="cuda"), normalized, self.flow_steps, noise, first
            ).float()
        medoid = torch.cdist(chunks.flatten(1), chunks.flatten(1)).sum(1).argmin()
        return chunks[medoid].cpu().numpy()

    def start(self, context) -> None:
        prompt = context.task.prompt
        if prompt not in self.config.prompts:
            # The checkpoint knows only its training instructions; any other runs under the first of them.
            log.warning("Instruction not seen in training, using the training instruction instead: %s", prompt)
            prompt = self.config.prompts[0]
        self.prompt = self.config.prompts.index(prompt)
        self.anchor = None  # the first camera frame of the attempt
        self.states = []  # every measured state of the attempt

    def restart(self) -> None:
        self.anchor = None
        self.states = self.states[-1:]

    def observe(self, observation) -> None:
        super().observe(observation)
        self.states.append(observation.state)

    def plan(self, observation) -> np.ndarray:
        expected = (self.config.image_height, self.config.image_width, 3)
        if observation.rgb.shape != expected:
            raise ValueError(f"Camera frame {observation.rgb.shape} does not match training {expected}")
        if self.anchor is None:
            self.anchor = observation.rgb
        states = [self.states[max(len(self.states) - 1 - lag, 0)] for lag in (0, *self.config.history)]
        return self.sample(observation.rgb, np.stack(states), self.prompt, self.anchor)


def create(policy_class=VlaPolicy) -> VlaPolicy:
    return policy_class(
        os.environ["STACKLING_VLA_CHECKPOINT"],
        int(os.environ.get("STACKLING_VLA_EXECUTE", "8")),
        int(os.environ.get("STACKLING_VLA_FLOW_STEPS", "10")),
        float(os.environ.get("STACKLING_VLA_NOISE_SCALE", "1")),
        int(os.environ.get("STACKLING_VLA_SAMPLES", "1")),
        float(os.environ.get("STACKLING_VLA_ATTEMPT", "0")),
    )
