"""Train the VLA on a prepared index.

    torchrun --nproc_per_node 4 -m stackling_vla.train --data INDEX --out RUN

Each checkpoint directory holds config.json and the EMA weights; serving loads
it directly. Progress goes to stderr and RUN/log.jsonl.
"""

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from safetensors.torch import load_file, save_file
from torch.utils.data import DataLoader, Subset, WeightedRandomSampler

from .codec import GAPS, JOINTS
from .data import WindowDataset
from .model import VLA, VLAConfig

FROZEN = "backbone.llm.embed_tokens."  # reloaded from the base model


def batches(loader):
    while True:
        yield from loader


def to_device(batch):
    return {k: v.cuda(non_blocking=True) for k, v in batch.items()}


def photometric(frames):
    """Per-image gain, per-channel offset and pixel noise.

    Recorded frames are decoded video while serving receives lossless frames
    (measured difference: about 39 dB PSNR and up to two levels of channel
    bias), so the model must not depend on exact pixel values.
    """
    b = frames.shape[0]
    gain = 1 + 0.04 * (2 * torch.rand(b, 1, 1, 1, device=frames.device) - 1)
    offset = 5 * (2 * torch.rand(b, 1, 1, 3, device=frames.device) - 1)
    return (frames.float() * gain + offset + 2 * torch.randn(frames.shape, device=frames.device)).clamp_(0, 255)


def shifted(frames, pixels: float):
    """Translate every image by its own sub-pixel offset of up to ``pixels`` along each axis.

    The head camera turns with the waist. In the demonstrations the background is static to the
    pixel whenever the waist rests, so the image betrays a waist motion of a fraction of a
    milliradian; a served policy never holds the waist that still.
    """
    b, h, w, _ = frames.shape
    theta = torch.zeros(b, 2, 3, device=frames.device)
    theta[:, 0, 0] = theta[:, 1, 1] = 1
    theta[:, :, 2] = (
        (2 * torch.rand(b, 2, device=frames.device) - 1) * pixels * 2 / torch.tensor([w, h], device=frames.device)
    )
    grid = F.affine_grid(theta, (b, 3, h, w), align_corners=False)
    moved = F.grid_sample(frames.permute(0, 3, 1, 2).float(), grid, padding_mode="border", align_corners=False)
    return moved.permute(0, 2, 3, 1)


class GradientSync:
    """Average gradients across processes through one bfloat16 buffer.

    The machine has no fast GPU interconnect, so the cost of a step is dominated
    by the bytes exchanged. Half-width gradients and local accumulation of
    several batches per exchange keep that cost small.
    """

    def __init__(self, params, world):
        self.params = params
        self.world = world
        self.buffer = torch.empty(sum(p.numel() for p in params), dtype=torch.bfloat16, device="cuda")

    @torch.no_grad()
    def __call__(self):
        offset = 0
        for p in self.params:
            self.buffer[offset : offset + p.numel()].copy_(p.grad.view(-1))
            offset += p.numel()
        torch.distributed.all_reduce(self.buffer)
        offset = 0
        for p in self.params:
            p.grad.copy_(self.buffer[offset : offset + p.numel()].view_as(p)).div_(self.world)
            offset += p.numel()


class Ema:
    def __init__(self, model, decay):
        self.params = [p for p in model.parameters() if p.requires_grad]
        self.shadow = [p.detach().clone() for p in self.params]
        self.decay = decay
        self.updates = 0

    @torch.no_grad()
    def update(self):
        self.updates += 1
        decay = min(self.decay, (1 + self.updates) / (10 + self.updates))
        torch._foreach_lerp_(self.shadow, [p.detach() for p in self.params], 1 - decay)

    @torch.no_grad()
    def swap(self):
        for p, s in zip(self.params, self.shadow):
            tmp = p.detach().clone()
            p.copy_(s)
            s.copy_(tmp)


@torch.no_grad()
def validate(model, loader, codec, limit):
    """Flow loss and sampled-chunk error in physical units over the first executed steps."""
    model.eval()
    scale = torch.tensor(codec.joint_scale, device="cuda")
    losses, joint, gap = [], [], []
    generator = torch.Generator("cuda").manual_seed(0)
    for i, batch in enumerate(loader):
        if i == limit:
            break
        b = to_device(batch)
        with torch.autocast("cuda", torch.bfloat16):
            torch.manual_seed(i)
            losses.append(model(b["frame"], b["prompt"], b["state"], b["actions"], anchor=b.get("anchor")).item())
            noise = torch.randn(b["actions"].shape, device="cuda", generator=generator)
            sampled = model.sample(b["frame"], b["prompt"], b["state"], noise=noise, anchor=b.get("anchor"))
        error = (sampled - b["actions"]).abs()[:, :8]
        joint.append((error[:, :, JOINTS] * scale[:8]).mean().item())
        gap.append((error[:, :, GAPS] * codec.gap_std).mean().item())
    model.train()
    return {
        "val_loss": float(np.mean(losses)),
        "val_joint_rad": float(np.mean(joint)),
        "val_gap_m": float(np.mean(gap)),
    }


def save(model, out: Path, step: int):
    directory = out / f"step-{step:06d}"
    directory.mkdir(parents=True, exist_ok=True)
    state = {k: v for k, v in model.state_dict().items() if not k.startswith(FROZEN)}
    save_file(state, directory / "model.safetensors")
    (directory / "config.json").write_text(json.dumps(model.config.to_dict(), indent=2) + "\n")
    (directory / "step").write_text(f"{step}\n")  # written last: marks the checkpoint complete


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--steps", type=int, default=20000)
    parser.add_argument("--batch", type=int, default=12, help="per process and accumulation step")
    parser.add_argument("--accumulate", type=int, default=2, help="batches per optimizer step")
    parser.add_argument("--noise-samples", type=int, default=4)
    parser.add_argument("--expert-lr", type=float, default=1e-4)
    parser.add_argument("--backbone-lr", type=float, default=2e-5)
    parser.add_argument("--warmup", type=int, default=500)
    parser.add_argument("--ema", type=float, default=0.999)
    parser.add_argument("--downsample", default="4x", choices=["4x", "16x"])
    parser.add_argument("--llm-layers", type=int, default=12)
    parser.add_argument("--vision-frozen-layers", type=int, default=14)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--save-every", type=int, default=2000)
    parser.add_argument("--val-every", type=int, default=500)
    parser.add_argument("--val-batches", type=int, default=16)
    parser.add_argument("--compile", action="store_true")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--init", help="checkpoint to continue from; fixes the architecture and statistics")
    parser.add_argument("--base", default=VLAConfig.base, help="directory of the pretrained MiniCPM-V model")
    parser.add_argument("--anchor", action="store_true", help="also feed the episode's first frame")
    parser.add_argument("--shift", type=float, default=0.0, help="random image translation in pixels")
    parser.add_argument("--state-noise", type=float, default=0.0, help="joint state shift in radians, see data.py")
    parser.add_argument(
        "--history",
        type=lambda text: [int(lag) for lag in text.split(",")],
        default=[],
        help="earlier states to feed, as observation steps back, e.g. 10,20,40,80",
    )
    parser.add_argument("--long-episode-seconds", type=float, default=18.0)
    parser.add_argument(
        "--long-episode-weight",
        type=float,
        default=1.0,
        help="sampling weight of observations from episodes longer than --long-episode-seconds",
    )
    args = parser.parse_args()

    rank = int(os.environ.get("RANK", 0))
    world = int(os.environ.get("WORLD_SIZE", 1))
    distributed = world > 1
    torch.cuda.set_device(int(os.environ.get("LOCAL_RANK", 0)))
    if distributed:
        torch.distributed.init_process_group("nccl")
    torch.manual_seed(args.seed)  # identical initial weights in every process
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    out = Path(args.out)

    init = json.loads((Path(args.init) / "config.json").read_text()) if args.init else None
    anchor = init.get("anchor", False) if init else args.anchor
    history = init.get("history", []) if init else args.history
    train = WindowDataset(args.data, "train", init and init["stats"], anchor, args.state_noise, history)
    # Episodes that relocate a cube before stacking are the minority and the hardest; they are the long ones.
    weights = np.where(train.episode_seconds() > args.long_episode_seconds, args.long_episode_weight, 1.0)
    sampler = WeightedRandomSampler(
        torch.from_numpy(weights), len(train) // world, generator=torch.Generator().manual_seed(args.seed * 1000 + rank)
    )
    loader = DataLoader(
        train,
        batch_size=args.batch,
        sampler=sampler,
        num_workers=args.workers,
        pin_memory=True,
        drop_last=True,
        persistent_workers=True,
        prefetch_factor=4,
    )
    config = (
        VLAConfig(**init)
        if init
        else VLAConfig(
            base=args.base,
            image_height=train.meta["contract"]["camera"]["heightPixels"],
            image_width=train.meta["contract"]["camera"]["width"],
            downsample=args.downsample,
            llm_layers=args.llm_layers,
            vision_frozen_layers=args.vision_frozen_layers,
            horizon=train.meta["horizon"],
            stats=train.meta["stats"],
            prompts=train.meta["prompts"],
            anchor=anchor,
            history=history,
        )
    )
    if (config.prompts, config.horizon) != (train.meta["prompts"], train.meta["horizon"]):
        raise ValueError("Checkpoint and index disagree on prompts or horizon")
    model = VLA(config)
    if init:
        model.load_state_dict(load_file(Path(args.init) / "model.safetensors"), strict=False)
    model.cuda()
    torch.manual_seed(args.seed + 1 + rank)
    expert = [p for p in model.expert.parameters()]
    backbone = [p for p in model.backbone.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(
        [{"params": expert, "lr": args.expert_lr}, {"params": backbone, "lr": args.backbone_lr}],
        betas=(0.9, 0.95),
        weight_decay=0.0,
        fused=True,
    )
    base_lrs = [g["lr"] for g in optimizer.param_groups]

    def lr_factor(step):
        if step < args.warmup:
            return (step + 1) / args.warmup
        progress = (step - args.warmup) / max(1, args.steps - args.warmup)
        return 0.1 + 0.45 * (1 + math.cos(math.pi * progress))

    forward = torch.compile(model) if args.compile else model

    def augment(frames):
        return photometric(shifted(frames, args.shift) if args.shift else frames)

    sync = GradientSync(expert + backbone, world) if distributed else None
    if rank == 0:
        out.mkdir(parents=True, exist_ok=True)
        (out / "args.json").write_text(json.dumps(vars(args) | {"world": world}, indent=2) + "\n")
        ema = Ema(model, args.ema)
        val = WindowDataset(args.data, "val", config.stats, anchor, history=history)
        # A fixed random subset: consecutive anchors would cover one episode only.
        chosen = np.random.default_rng(0).permutation(len(val))[: args.val_batches * args.batch]
        val_loader = DataLoader(Subset(val, chosen.tolist()), batch_size=args.batch, num_workers=4)
        log = open(out / "log.jsonl", "a")

    stream = batches(loader)
    window_loss, window_wait, window_start = 0.0, 0.0, time.perf_counter()
    for step in range(1, args.steps + 1):
        for group, base in zip(optimizer.param_groups, base_lrs):
            group["lr"] = base * lr_factor(step - 1)
        optimizer.zero_grad(set_to_none=True)
        for _ in range(args.accumulate):
            t = time.perf_counter()
            batch = to_device(next(stream))
            window_wait += time.perf_counter() - t
            with torch.autocast("cuda", torch.bfloat16):
                loss = forward(
                    augment(batch["frame"]),
                    batch["prompt"],
                    batch["state"],
                    batch["actions"],
                    args.noise_samples,
                    augment(batch["anchor"]) if anchor else None,
                )
            (loss / args.accumulate).backward()
        if sync:
            sync()
        torch.nn.utils.clip_grad_norm_(expert + backbone, 1.0)
        optimizer.step()
        if rank != 0:
            continue
        ema.update()
        window_loss += loss.item()
        if step % 50 == 0:
            elapsed = time.perf_counter() - window_start
            record = {
                "step": step,
                "loss": window_loss / 50,
                "samples_per_s": 50 * args.batch * args.accumulate * world / elapsed,
                "data_wait": window_wait / elapsed,
            }
            if step % args.val_every == 0 or step == args.steps:
                ema.swap()
                record |= validate(model, val_loader, train.codec, args.val_batches)
                ema.swap()
            print(json.dumps(record), file=sys.stderr, flush=True)
            log.write(json.dumps(record) + "\n")
            log.flush()
            window_loss, window_wait, window_start = 0.0, 0.0, time.perf_counter()
        if step % args.save_every == 0 or step == args.steps:
            ema.swap()
            save(model, out, step)
            ema.swap()
            window_start = time.perf_counter()
    if rank == 0:
        (out / "done").write_text("")


if __name__ == "__main__":
    main()
