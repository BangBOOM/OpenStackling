"""MLX inference for the trained MiniCPM-V prefix and flow-matching expert."""

import json
import math
import os
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import numpy as np
from mlx_vlm.models.minicpmv4_7 import MiniCPMV4_7Processor, ModelConfig
from mlx_vlm.models.minicpmv4_7.minicpmv4_7 import Model as MiniCPM
from mlx_vlm.models.minicpmv4_7.rope import CanvasRoPE
from PIL import Image

from .codec import CHANNELS, STATE_DIM
from .config import VLAConfig


class Backbone(MiniCPM):
    def __init__(self, config: VLAConfig):
        base = json.loads((Path(config.base) / "config.json").read_text())
        base["text_config"]["num_hidden_layers"] = config.llm_layers
        super().__init__(ModelConfig.from_dict(base))
        # The action expert consumes hidden states, so no vocabulary output head is needed.
        del self.language_model.lm_head
        self._downsample = config.downsample
        self._grid = np.array([[config.image_height // 14, config.image_width // 14]], np.int32)
        embeddings = self.vision_tower.embeddings
        side = embeddings._position_grid_size()
        boundaries = mx.array(np.arange(1 / side, 1.0, 1 / side).astype(np.float32))
        rows, columns = (embeddings._build_position_buckets(int(n), boundaries) for n in self._grid[0])
        self._vision_positions = (rows[:, None] * side + columns[None, :]).reshape(1, -1)
        mx.eval(self._vision_positions)
        self._prompts = []
        processor = MiniCPMV4_7Processor.from_pretrained(config.base)
        images = [Image.new("RGB", (config.image_width, config.image_height))] * (2 if config.anchor else 1)
        for prompt in config.prompts:
            text = processor.apply_chat_template(
                [
                    {
                        "role": "user",
                        "content": [
                            *[{"type": "image"} for _ in images],
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
            tokens = processor(text=text, images=images, max_slice_nums=1, downsample_mode=config.downsample)
            sizes = np.asarray(tokens["tgt_sizes"][0])
            if not np.array_equal(sizes, np.repeat(self._grid, len(images), axis=0)):
                raise ValueError(f"Processor resizes the camera image: {sizes.tolist()}")
            ids = np.asarray(tokens["input_ids"])
            positions, _ = CanvasRoPE(self.config).get_rope_index(
                ids,
                mm_token_type_ids=tokens["mm_token_type_ids"],
                target_sizes=sizes,
                downsample_mode=config.downsample,
            )
            self._prompts.append(
                (mx.array(ids), mx.array(positions), mx.array(np.flatnonzero(ids[0] == self.config.image_token_id)))
            )

    def vision(self, frame):
        embeddings = self.vision_tower.embeddings
        dtype = embeddings.patch_embedding.weight.dtype
        pixels = (frame.astype(mx.float32) / 127.5 - 1).astype(dtype)
        hidden = embeddings.patch_embedding(pixels[None]).flatten(1, 2)
        hidden = hidden + embeddings.position_embedding(self._vision_positions)
        height, width = map(int, self._grid[0])
        for index, layer in enumerate(self.vision_tower.encoder.layers):
            hidden = layer(hidden)
            if self._downsample != "4x" and index == self.config.insert_layer_id:
                hidden, height, width = self.vit_merger(hidden[0], height, width)
                hidden = hidden[None]
        hidden = self.vision_tower.post_layernorm(hidden)[0]
        return self.merger(hidden, height, width)[0].astype(dtype)

    def __call__(self, frame: mx.array, prompt: int, anchor: mx.array | None = None):
        ids, positions, indices = self._prompts[prompt]
        features = self.vision(frame)
        if anchor is not None:
            features = mx.concatenate([self.vision(anchor), features])
        embeds = self.language_model.model.embed_tokens(ids)
        embeds = embeds.at[0, indices].add(features.astype(embeds.dtype) - embeds[0, indices])
        return self.language_model.model(ids, inputs_embeds=embeds, position_ids=positions)


def timestep_embedding(t: mx.array, dim: int):
    half = dim // 2
    freqs = mx.exp(-math.log(10000) * mx.arange(half, dtype=mx.float32) / half)
    angles = t[:, None] * 1000 * freqs[None]
    return mx.concatenate([mx.sin(angles), mx.cos(angles)], axis=-1)


class ExpertBlock(nn.Module):
    def __init__(self, dim: int, heads: int):
        super().__init__()
        self.heads = heads
        self.norm1 = nn.LayerNorm(dim)
        self.qkv = nn.Linear(dim, 3 * dim)
        self.proj1 = nn.Linear(dim, dim)
        self.norm2 = nn.LayerNorm(dim)
        self.q = nn.Linear(dim, dim)
        self.kv = nn.Linear(dim, 2 * dim)
        self.proj2 = nn.Linear(dim, dim)
        self.norm3 = nn.LayerNorm(dim)
        self.mlp = nn.Sequential(nn.Linear(dim, 4 * dim), nn.GELU(approx="precise"), nn.Linear(4 * dim, dim))

    def _heads(self, x):
        return x.reshape(x.shape[0], x.shape[1], self.heads, -1).transpose(0, 2, 1, 3)

    def _attend(self, q, k, v):
        out = mx.fast.scaled_dot_product_attention(q, k, v, scale=q.shape[-1] ** -0.5)
        return out.transpose(0, 2, 1, 3).reshape(q.shape[0], q.shape[2], -1)

    def prepare(self, prefix, samples):
        return tuple(
            mx.broadcast_to(self._heads(x), (samples, self.heads, x.shape[1], x.shape[2] // self.heads))
            for x in mx.split(self.kv(prefix), 2, axis=-1)
        )

    def __call__(self, h, kv):
        q, k, v = (self._heads(x) for x in mx.split(self.qkv(self.norm1(h)), 3, axis=-1))
        h = h + self.proj1(self._attend(q, k, v))
        k, v = kv
        h = h + self.proj2(self._attend(self._heads(self.q(self.norm2(h))), k, v))
        return h + self.mlp(self.norm3(h))


class Expert(nn.Module):
    def __init__(self, config: VLAConfig, prefix_dim: int):
        super().__init__()
        d = config.expert_dim
        self.dim = d
        self.prefix = nn.Sequential(nn.Linear(prefix_dim, d), nn.LayerNorm(d))
        self.state_proj = nn.Linear(STATE_DIM, d)
        self.action = nn.Linear(CHANNELS, d)
        self.fuse = nn.Sequential(nn.Linear(2 * d, d), nn.SiLU(), nn.Linear(d, d))
        self.position = mx.zeros((1 + len(config.history) + config.horizon, d))
        self.blocks = [ExpertBlock(d, config.expert_heads) for _ in range(config.expert_layers)]
        self.norm = nn.LayerNorm(d)
        self.out = nn.Linear(d, CHANNELS)

    def prepare(self, state, prefix, samples):
        dtype = self.action.weight.dtype
        states = self.state_proj(state.astype(dtype)).reshape(1, -1, self.dim)
        states = mx.broadcast_to(states, (samples, states.shape[1], self.dim))
        return states, [block.prepare(prefix, samples) for block in self.blocks]

    def __call__(self, x, t, states, kvs):
        dtype = self.action.weight.dtype
        x = x.astype(dtype)
        time = mx.broadcast_to(timestep_embedding(t, self.dim)[:, None], (*x.shape[:2], self.dim)).astype(dtype)
        tokens = self.fuse(mx.concatenate([self.action(x), time], axis=-1))
        h = mx.concatenate([states, tokens], axis=1) + self.position
        for block, kv in zip(self.blocks, kvs):
            h = block(h, kv)
        return self.out(self.norm(h[:, states.shape[1] :]))


class VLA(nn.Module):
    def __init__(self, config: VLAConfig):
        super().__init__()
        self.config = config
        self.backbone = Backbone(config)
        self.expert = Expert(config, self.backbone.config.text_config.hidden_size)

    def sample(self, frame, prompt, state, steps, noise, anchor=None):
        prefix = self.expert.prefix(self.backbone(frame, prompt, anchor))
        states, kvs = self.expert.prepare(state, prefix, noise.shape[0])
        x = noise
        for i in range(steps):
            t = mx.full((x.shape[0],), i / steps)
            x = x + self.expert(x, t, states, kvs).astype(mx.float32) / steps
        return x


def load_model(checkpoint: str | Path) -> VLA:
    checkpoint = Path(checkpoint)
    bits = int(os.environ.get("STACKLING_VLA_BITS", "0"))
    if bits not in (0, 4, 8):
        raise ValueError("STACKLING_VLA_BITS must be 0, 4 or 8")
    config = json.loads((checkpoint / "config.json").read_text())
    config["base"] = os.environ.get("STACKLING_VLA_BASE", config["base"])
    model = VLA(VLAConfig(**config))
    weights = mx.load(str(checkpoint / "model.safetensors"))
    backbone, expert = {}, {}
    for key, value in weights.items():
        if key.startswith("backbone."):
            key = key.replace("backbone.vision.", "model.vision_tower.")
            key = key.replace("backbone.llm.", "model.language_model.")
            key = key.replace("backbone.merger.", "model.merger.")
            backbone[key] = value
        else:
            key = key.replace("expert.state.", "expert.state_proj.")
            for name in ("prefix", "fuse", "mlp"):
                key = key.replace(f".{name}.", f".{name}.layers.")
            expert[key] = value
    base_weights = mx.load(str(Path(config["base"]) / "model.safetensors"))
    embedding = "model.language_model.embed_tokens.weight"
    backbone[embedding] = base_weights[embedding]
    backbone = model.backbone.sanitize(backbone)
    converted = {f"backbone.{k}": v for k, v in backbone.items()}
    converted.update(expert)
    # Keep the recurrent decay parameters in float32, as in MLX-VLM.
    model.load_weights(
        [(k, v if k.endswith((".A_log", ".dt_bias")) else v.astype(mx.bfloat16)) for k, v in converted.items()]
    )
    model.eval()
    mx.eval(model.parameters())
    if bits:
        # Keep small action I/O projections and non-aligned vision matrices in bfloat16.
        nn.quantize(
            model,
            group_size=64,
            bits=bits,
            class_predicate=lambda path, layer: (
                isinstance(layer, nn.Linear)
                and layer.weight.shape[-1] % 64 == 0
                and path not in {"expert.action", "expert.state_proj", "expert.out"}
            ),
        )
        mx.eval(model.parameters())
    model.sample = mx.compile(model.sample)
    return model
