"""Checkpoint architecture and normalization shared by CUDA and MLX."""

from dataclasses import asdict, dataclass, field


@dataclass
class VLAConfig:
    base: str = "MiniCPM-V-4.7-1B"
    image_height: int = 392
    image_width: int = 504
    downsample: str = "4x"  # "4x": 252 image tokens; "16x": 63
    llm_layers: int = 24  # language-model depth kept
    vision_frozen_layers: int = 0  # leading vision layers that stay at the pretrained weights
    horizon: int = 32
    expert_dim: int = 768
    expert_layers: int = 8
    expert_heads: int = 12
    stats: dict = field(default_factory=dict)
    prompts: list = field(default_factory=list)
    anchor: bool = False  # the episode's first frame precedes the current frame
    history: list = field(default_factory=list)  # earlier measured states, as observation steps back

    def to_dict(self):
        return asdict(self)
