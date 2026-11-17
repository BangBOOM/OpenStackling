"""Flow-matching VLA: a MiniCPM-V prefix and a cross-attending action expert.

The backbone encodes one camera frame and the instruction into per-token hidden
states. The expert denoises an action chunk conditioned on those states and on
the measured robot state. Images have one fixed size, so every batch has the
same token layout and the HF processor stays out of the training path.
"""

import math

import torch
import torch.nn.functional as F
from torch import nn

from .codec import CHANNELS, STATE_DIM
from .config import VLAConfig

PATCH = 14


def tokenize_prompt(config: VLAConfig, prompt: str) -> dict:
    """Token ids, image-token mask and canvas positions for one instruction."""
    from PIL import Image
    from transformers import AutoProcessor

    processor = AutoProcessor.from_pretrained(config.base)
    image = Image.new("RGB", (config.image_width, config.image_height))
    images = [{"type": "image", "image": image}] * (2 if config.anchor else 1)
    encoded = processor.apply_chat_template(
        [{"role": "user", "content": [*images, {"type": "text", "text": prompt}]}],
        add_generation_prompt=True,
        enable_thinking=False,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
        processor_kwargs={"max_slice_nums": 1, "downsample_mode": config.downsample},
    )
    grid = [config.image_height // PATCH, config.image_width // PATCH]
    if encoded["target_sizes"].tolist() != [grid] * len(images):
        raise ValueError(f"Processor resizes the camera image: {encoded['target_sizes'].tolist()}")
    return {k: encoded[k] for k in ("input_ids", "mm_token_type_ids", "target_sizes")}


class Backbone(nn.Module):
    def __init__(self, config: VLAConfig):
        super().__init__()
        from transformers import AutoModel

        self.config = config
        core = AutoModel.from_pretrained(config.base, dtype=torch.float32, attn_implementation="sdpa")
        self.vision = core.vision_tower
        self.merger = core.merger
        self.llm = core.language_model
        self.llm.layers = self.llm.layers[: config.llm_layers]
        self.llm.config.num_hidden_layers = config.llm_layers
        self.llm.embed_tokens.requires_grad_(False)
        self.image_token = core.config.image_token_id
        self.grid = (config.image_height // PATCH, config.image_width // PATCH)
        from transformers.vision_utils import get_vision_nearest_position_ids

        sizes = torch.tensor([self.grid])
        self.register_buffer(
            "patch_positions",
            get_vision_nearest_position_ids(sizes, self.vision.embeddings.num_patches_per_side),
            persistent=False,
        )
        if config.downsample == "16x":
            self.register_buffer("window_index", self.vision.vit_merger.get_window_index(sizes)[0], persistent=False)
        else:
            self.vision.vit_merger.requires_grad_(False)
        self.frozen = config.vision_frozen_layers
        if self.frozen:
            self.vision.embeddings.requires_grad_(False)
            self.vision.encoder.layers[: self.frozen].requires_grad_(False)
        tokens = [tokenize_prompt(config, p) for p in config.prompts]
        if len({t["input_ids"].shape[1] for t in tokens}) != 1:
            raise ValueError("Prompts must tokenize to one length")
        positions = [
            core.compute_3d_position_ids(
                t["input_ids"],
                target_sizes=t["target_sizes"],
                mm_token_type_ids=t["mm_token_type_ids"],
                downsample_mode=config.downsample,
            )
            for t in tokens
        ]
        self.register_buffer("prompt_ids", torch.cat([t["input_ids"] for t in tokens]), persistent=False)
        self.register_buffer("prompt_positions", torch.cat(positions, dim=1), persistent=False)

    @staticmethod
    def _attend(attention, x):
        b, n, d = x.shape
        shape = (b, n, attention.num_heads, attention.head_dim)
        q, k, v = (p(x).view(shape).transpose(1, 2) for p in (attention.q_proj, attention.k_proj, attention.v_proj))
        out = F.scaled_dot_product_attention(q, k, v)
        return attention.out_proj(out.transpose(1, 2).reshape(b, n, d))

    def _layer(self, layer, h):
        h = h + self._attend(layer.self_attn, layer.layer_norm1(h))
        return h + layer.mlp(layer.layer_norm2(h))

    def _merge_windows(self, h):
        """The tower's 2x2 window merger over a batch of equal grids."""
        m = self.vision.vit_merger
        b, n, d = h.shape
        windows = h[:, self.window_index].reshape(b * n // 4, 4, d)
        windows = windows + self._attend(m.self_attn, m.layer_norm1(windows))
        merged = m.linear_2(m.act(m.linear_1(m.pre_norm(windows.flatten(1))))) + windows.mean(1)
        return merged.view(b, n // 4, d)

    def image_features(self, frames):
        """uint8 frames [B,H,W,3] -> image tokens [B,T,llm_dim]."""
        v = self.vision
        merge_at = v.config.insert_layer_id if self.config.downsample == "16x" else -1
        if self.frozen > merge_at >= 0:
            raise ValueError("The window merger must stay inside the trained vision layers")
        with torch.set_grad_enabled(self.frozen == 0 and torch.is_grad_enabled()):
            x = (frames.permute(0, 3, 1, 2).float() / 127.5 - 1).to(v.embeddings.patch_embedding.weight.dtype)
            h = v.embeddings.patch_embedding(x).flatten(2).transpose(1, 2)
            h = h + v.embeddings.position_embedding(self.patch_positions)
            for layer in v.encoder.layers[: self.frozen]:
                h = self._layer(layer, h)
        gh, gw = self.grid
        for i, layer in enumerate(v.encoder.layers[self.frozen :], self.frozen):
            h = self._layer(layer, h)
            if i == merge_at:
                h = self._merge_windows(h)
                gh, gw = gh // 2, gw // 2
        h = v.post_layernorm(h)
        b, _, d = h.shape
        h = h.view(b, gh // 2, 2, gw // 2, 2, d).permute(0, 1, 3, 2, 4, 5).reshape(b, -1, 4 * d)
        return self.merger.mlp[0](h).view(b, gh * gw // 4, -1)

    def forward(self, frames, prompt, anchor=None):
        """frames (and anchor) uint8 [B,H,W,3], prompt index [B] -> hidden states [B,L,llm_dim]."""
        ids = self.prompt_ids[prompt]
        embeds = self.llm.embed_tokens(ids)
        if anchor is None:
            features = self.image_features(frames)
        else:
            features = torch.cat(self.image_features(torch.cat([anchor, frames])).chunk(2), dim=1)
        features = features.to(embeds.dtype)
        embeds = embeds.masked_scatter((ids == self.image_token)[..., None], features)
        positions = self.prompt_positions[:, prompt]
        return self.llm(inputs_embeds=embeds, position_ids=positions, use_cache=False).last_hidden_state


def timestep_embedding(t, dim):
    half = dim // 2
    freqs = torch.exp(-math.log(10000) * torch.arange(half, device=t.device) / half)
    angles = t[:, None].float() * 1000 * freqs[None]
    return torch.cat([angles.sin(), angles.cos()], dim=-1)


class ExpertBlock(nn.Module):
    def __init__(self, dim, heads):
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
        self.mlp = nn.Sequential(nn.Linear(dim, 4 * dim), nn.GELU(), nn.Linear(4 * dim, dim))

    def _heads(self, x):
        return x.view(x.shape[0], x.shape[1], self.heads, -1).transpose(1, 2)

    def forward(self, h, prefix):
        b, n, d = h.shape
        q, k, v = (self._heads(x) for x in self.qkv(self.norm1(h)).chunk(3, dim=-1))
        h = h + self.proj1(F.scaled_dot_product_attention(q, k, v).transpose(1, 2).reshape(b, n, d))
        k, v = (self._heads(x) for x in self.kv(prefix).chunk(2, dim=-1))
        q = self._heads(self.q(self.norm2(h)))
        h = h + self.proj2(F.scaled_dot_product_attention(q, k, v).transpose(1, 2).reshape(b, n, d))
        return h + self.mlp(self.norm3(h))


class Expert(nn.Module):
    def __init__(self, config: VLAConfig, prefix_dim: int):
        super().__init__()
        d = config.expert_dim
        self.dim = d
        self.prefix = nn.Sequential(nn.Linear(prefix_dim, d), nn.LayerNorm(d))
        self.state = nn.Linear(STATE_DIM, d)
        self.action = nn.Linear(CHANNELS, d)
        self.fuse = nn.Sequential(nn.Linear(2 * d, d), nn.SiLU(), nn.Linear(d, d))
        self.position = nn.Parameter(torch.randn(1 + len(config.history) + config.horizon, d) * 0.02)
        self.blocks = nn.ModuleList(ExpertBlock(d, config.expert_heads) for _ in range(config.expert_layers))
        self.norm = nn.LayerNorm(d)
        self.out = nn.Linear(d, CHANNELS)

    def forward(self, x, t, state, prefix):
        """x noised chunk [B,H,C], t [B], prefix already projected [B,L,d].

        state [B,16], or [B,1+K,16] holding the current state followed by the K history states.
        """
        time = timestep_embedding(t, self.dim).to(x.dtype)[:, None].expand(-1, x.shape[1], -1)
        tokens = self.fuse(torch.cat([self.action(x), time], dim=-1))
        states = self.state(state).view(x.shape[0], -1, self.dim)
        h = torch.cat([states, tokens], dim=1) + self.position
        for block in self.blocks:
            h = block(h, prefix)
        return self.out(self.norm(h[:, states.shape[1] :]))


class VLA(nn.Module):
    def __init__(self, config: VLAConfig):
        super().__init__()
        self.config = config
        self.backbone = Backbone(config)
        self.expert = Expert(config, self.backbone.llm.config.hidden_size)

    def forward(self, frames, prompt, state, actions, noise_samples: int = 4, anchor=None):
        """Flow-matching loss. One backbone pass serves ``noise_samples`` noise draws."""
        prefix = self.expert.prefix(self.backbone(frames, prompt, anchor))
        k = noise_samples
        prefix, state, actions = (x.repeat_interleave(k, dim=0) for x in (prefix, state, actions))
        # Time 0 is noise and 1 is data; sampling favours the noisy end.
        beta = torch.distributions.Beta(1.5, 1.0).sample((actions.shape[0],)).to(actions.device)
        t = (1 - beta) * 0.999
        noise = torch.randn_like(actions)
        tt = t[:, None, None]
        velocity = self.expert(tt * actions + (1 - tt) * noise, t, state, prefix.to(actions.dtype))
        return F.mse_loss(velocity.float(), actions - noise)

    @torch.no_grad()
    def sample(self, frames, prompt, state, steps: int = 10, noise=None, anchor=None):
        """One chunk per noise row; ``noise`` may hold several rows per observation, in observation order."""
        prefix = self.expert.prefix(self.backbone(frames, prompt, anchor)).float()
        x = (
            noise
            if noise is not None
            else torch.randn(frames.shape[0], self.config.horizon, CHANNELS, device=frames.device)
        )
        draws = x.shape[0] // frames.shape[0]
        prefix, state = (v.repeat_interleave(draws, dim=0) for v in (prefix, state))
        for i in range(steps):
            t = torch.full((x.shape[0],), i / steps, device=x.device)
            x = x + self.expert(x, t, state, prefix).float() / steps
        return x
