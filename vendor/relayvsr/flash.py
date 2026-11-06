"""Streaming 4x decoder of RelayVSR: LR frames conditioned on two Wan keyframe latents."""

import math
from dataclasses import dataclass

import comfy.model_management
import torch
import torch.nn.functional as F
from torch import nn

from .attention import local_attention

ROPE_DIMS = (16, 24, 24)
ROPE_THETA = 10000.0
ENCODER_DOWNSCALE = 4


@dataclass(frozen=True)
class KVCache:
    key: torch.Tensor
    value: torch.Tensor


class FlashStream:
    """Temporary tables of one upscale run: attention index plans and RoPE."""

    def __init__(self):
        self.attention_plans = {}
        self.rope = {}


def _rope_grid(temporal_positions, height, width, dtype):
    device = temporal_positions.device
    grid = torch.meshgrid(temporal_positions, torch.arange(height, device=device), torch.arange(width, device=device), indexing="ij")
    cosines, sines = [], []
    for positions, size in zip(grid, ROPE_DIMS):
        indices = torch.arange(0, size, 2, dtype=torch.float32, device=device)
        angles = positions.flatten().to(torch.float32).unsqueeze(-1) / (ROPE_THETA ** (indices / size))
        cosines.append(angles.cos().repeat_interleave(2, dim=-1))
        sines.append(angles.sin().repeat_interleave(2, dim=-1))
    return torch.cat(cosines, dim=-1).to(dtype), torch.cat(sines, dim=-1).to(dtype)


def _rotate(tensor, cosines, sines):
    even, odd = tensor[..., 0::2], tensor[..., 1::2]
    rotated = torch.empty_like(tensor)
    rotated[..., 0::2] = even * cosines[..., 0::2] - odd * sines[..., 0::2]
    rotated[..., 1::2] = even * sines[..., 1::2] + odd * cosines[..., 1::2]
    return rotated


class LRFrameEncoder(nn.Module):
    def __init__(self, dim, channels, norm_eps, operations):
        super().__init__()
        layers = []
        in_channels = 3
        for out_channels, stride in zip(channels, (2, 2, 1)):
            layers += [operations.Conv2d(in_channels, out_channels, kernel_size=3, stride=stride, padding=1), nn.SiLU()]
            in_channels = out_channels
        layers.append(operations.Conv2d(in_channels, dim, kernel_size=1))
        self.layers = nn.Sequential(*layers)
        self.norm = operations.RMSNorm(dim, eps=norm_eps)

    def forward(self, frame):
        return self.norm(self.layers(frame).flatten(2).transpose(1, 2))


class ConditionEncoder(nn.Module):
    def __init__(self, latent_channels, dim, norm_eps, operations):
        super().__init__()
        self.projection = operations.Conv2d(latent_channels, dim, kernel_size=1)
        self.norm = operations.RMSNorm(dim, eps=norm_eps)

    def forward(self, latent):
        return self.norm(self.projection(latent).flatten(2).transpose(1, 2))


class GroupedQueryAttention(nn.Module):
    def __init__(self, dim, num_heads, num_kv_groups, norm_eps, windows, operations):
        super().__init__()
        self.dim = dim
        self.num_heads = num_heads
        self.num_kv_groups = num_kv_groups
        self.head_dim = dim // num_heads
        self.windows = windows
        kv_dim = num_kv_groups * self.head_dim
        self.query = operations.Linear(dim, dim)
        self.key = operations.Linear(dim, kv_dim)
        self.value = operations.Linear(dim, kv_dim)
        self.condition_key = operations.Linear(dim, kv_dim)
        self.condition_value = operations.Linear(dim, kv_dim)
        self.key_norm = operations.RMSNorm(self.head_dim, eps=norm_eps)
        self.value_norm = operations.RMSNorm(self.head_dim, eps=norm_eps)
        self.output = operations.Linear(dim, dim)

    def _project(self, hidden_states, key_projection, value_projection):
        tokens = hidden_states.shape[1]
        query = self.query(hidden_states).view(tokens, self.num_heads, self.head_dim).transpose(0, 1)
        key = key_projection(hidden_states).view(tokens, self.num_kv_groups, self.head_dim).transpose(0, 1)
        value = value_projection(hidden_states).view(tokens, self.num_kv_groups, self.head_dim).transpose(0, 1)
        return query, self.key_norm(key), self.value_norm(value)

    def _attend(self, query, key, value, query_rope, key_rope, height, width, windows, stream):
        attended = local_attention(
            _rotate(query, *query_rope),
            _rotate(key, *key_rope),
            value,
            height=height,
            width=width,
            planes=tuple((plane, *window) for plane, window in enumerate(windows)),
            shifted=False,
            plans=stream.attention_plans,
        )
        return self.output(attended.transpose(0, 1).reshape(1, -1, self.dim))

    def prime_condition(self, hidden_states, rope, height, width, stream):
        query, key, value = self._project(hidden_states, self.condition_key, self.condition_value)
        attended = self._attend(query, key, value, rope, rope, height, width, (self.windows["condition_self"],), stream)
        return attended, KVCache(key, value)

    def forward_video(self, hidden_states, video_cache, condition_cache, query_rope, key_rope, height, width, stream):
        query, key, value = self._project(hidden_states, self.key, self.value)
        if video_cache is not None:
            key = torch.cat((video_cache.key, key), dim=1)
            value = torch.cat((video_cache.value, value), dim=1)
        video_planes = key.shape[1] // (height * width)
        windows = (self.windows["start"], self.windows["end"]) + (self.windows["video"],) * video_planes
        attended = self._attend(
            query,
            torch.cat((condition_cache.key, key), dim=1),
            torch.cat((condition_cache.value, value), dim=1),
            query_rope,
            key_rope,
            height,
            width,
            windows,
            stream,
        )
        return attended, KVCache(key, value)


class SwiGLU(nn.Module):
    def __init__(self, dim, hidden_dim, operations):
        super().__init__()
        self.gate_up_proj = operations.Linear(dim, 2 * hidden_dim, bias=False)
        self.down = operations.Linear(hidden_dim, dim, bias=False)

    def forward(self, hidden_states):
        gate, up = self.gate_up_proj(hidden_states).chunk(2, dim=-1)
        return self.down(F.silu(gate) * up)


class TransformerBlock(nn.Module):
    def __init__(self, dim, num_heads, num_kv_groups, hidden_dim, norm_eps, windows, operations):
        super().__init__()
        self.attention_norm = operations.RMSNorm(dim, eps=norm_eps)
        self.attention = GroupedQueryAttention(dim, num_heads, num_kv_groups, norm_eps, windows, operations)
        self.feed_forward_norm = operations.RMSNorm(dim, eps=norm_eps)
        self.feed_forward = SwiGLU(dim, hidden_dim, operations)

    def _feed_forward(self, hidden_states):
        return hidden_states + self.feed_forward(self.feed_forward_norm(hidden_states))

    def prime_condition(self, hidden_states, rope, height, width, stream):
        attended, cache = self.attention.prime_condition(self.attention_norm(hidden_states), rope, height, width, stream)
        return self._feed_forward(hidden_states + attended), cache

    def forward_video(self, hidden_states, video_cache, condition_cache, query_rope, key_rope, height, width, stream):
        attended, cache = self.attention.forward_video(
            self.attention_norm(hidden_states), video_cache, condition_cache, query_rope, key_rope, height, width, stream
        )
        return self._feed_forward(hidden_states + attended), cache


class Backbone(nn.Module):
    def __init__(self, depth, dim, num_heads, num_kv_groups, hidden_dim, norm_eps, windows, operations):
        super().__init__()
        self.blocks = nn.ModuleList(
            [TransformerBlock(dim, num_heads, num_kv_groups, hidden_dim, norm_eps, windows, operations) for _ in range(depth)]
        )


class FlashDecoder(nn.Module):
    """RelayVSR Flash, variant S (the only published one)."""

    def __init__(self, config, operations):
        super().__init__()
        dim, depth, num_heads, num_kv_groups = 512, 10, 8, 2
        spatial = config["spatial_attention"]
        windows = {
            "video": tuple(spatial["video_window_size"]),
            "start": tuple(spatial["start_condition_window_size"]),
            "end": tuple(spatial["end_condition_window_size"]),
            "condition_self": tuple(spatial["condition_self_window_size"]),
        }
        norm_eps = config["norm_eps"]
        hidden_dim = math.ceil(dim * config["mlp_ratio"] / 64) * 64
        head_dim = config["spatial_head_dim"]
        self.upscale_factor = config["upscale_factor"]
        self.shuffle_factor = ENCODER_DOWNSCALE * self.upscale_factor
        self.video_frames = config["window_size"]

        self.lr_encoder = LRFrameEncoder(dim, config["encoder_channels"], norm_eps, operations)
        self.condition_encoder = ConditionEncoder(config["condition_channels"], dim, norm_eps, operations)
        self.video_type_embedding = nn.Parameter(torch.empty(1, 1, dim))
        self.condition_type_embedding = nn.Parameter(torch.empty(1, 1, dim))
        self.backbone = Backbone(depth, dim, num_heads, num_kv_groups, hidden_dim, norm_eps, windows, operations)
        self.spatial_head = nn.Sequential(operations.Linear(dim, head_dim), nn.SiLU())
        output_channels = 3 * self.shuffle_factor**2
        self.residual_projection = operations.Linear(head_dim, output_channels)
        # Training-only RGB head of the condition, present in the checkpoint.
        self.condition_rgb_projection = operations.Linear(head_dim, output_channels)

    def _query_rope(self, stream, height, width, device, dtype):
        if "query" not in stream.rope:
            stream.rope["query"] = _rope_grid(torch.zeros(1, device=device, dtype=torch.long), height, width, dtype)
        return stream.rope["query"]

    def _key_rope(self, stream, height, width, previous_frames, device, dtype):
        """Conditions sit at t=0; the history is placed behind the current frame."""
        if previous_frames not in stream.rope:
            conditions = _rope_grid(torch.zeros(2, device=device, dtype=torch.long), height, width, dtype)
            video = _rope_grid(torch.arange(-previous_frames, 1, device=device), height, width, dtype)
            stream.rope[previous_frames] = tuple(torch.cat(parts, dim=0) for parts in zip(conditions, video))
        return stream.rope[previous_frames]

    def prepare_condition(self, latent, stream):
        """Per-layer KV of a keyframe, shared by the two windows that meet at it."""
        height, width = latent.shape[-2:]
        embedding = comfy.model_management.cast_to(self.condition_type_embedding, latent.dtype, latent.device)
        hidden_states = self.condition_encoder(latent) + embedding
        rope = self._query_rope(stream, height, width, latent.device, latent.dtype)
        caches = []
        for block in self.backbone.blocks:
            hidden_states, cache = block.prime_condition(hidden_states, rope, height, width, stream)
            caches.append(cache)
        return caches

    def merge_conditions(self, start, end):
        return [
            KVCache(torch.cat((a.key, b.key), dim=1), torch.cat((a.value, b.value), dim=1))
            for a, b in zip(start, end)
        ]

    def decode_step(self, frame, video_caches, condition_caches, stream):
        """Upscale one LR frame [1,3,H,W] in [-1,1], with H and W multiples of 4."""
        height = frame.shape[-2] // ENCODER_DOWNSCALE
        width = frame.shape[-1] // ENCODER_DOWNSCALE
        tokens = height * width
        keep = (self.video_frames - 1) * tokens
        video_caches = [
            None if cache is None else KVCache(cache.key[:, -keep:], cache.value[:, -keep:])
            for cache in video_caches
        ]
        previous_frames = 0 if video_caches[0] is None else video_caches[0].key.shape[1] // tokens
        query_rope = self._query_rope(stream, height, width, frame.device, frame.dtype)
        key_rope = self._key_rope(stream, height, width, previous_frames, frame.device, frame.dtype)

        embedding = comfy.model_management.cast_to(self.video_type_embedding, frame.dtype, frame.device)
        hidden_states = self.lr_encoder(frame) + embedding
        next_caches = []
        for block, video_cache, condition_cache in zip(self.backbone.blocks, video_caches, condition_caches):
            hidden_states, cache = block.forward_video(
                hidden_states, video_cache, condition_cache, query_rope, key_rope, height, width, stream
            )
            next_caches.append(cache)

        pixels = self.residual_projection(self.spatial_head(hidden_states))
        pixels = pixels.transpose(1, 2).reshape(1, 3 * self.shuffle_factor**2, height, width)
        bicubic = F.interpolate(frame, scale_factor=self.upscale_factor, mode="bicubic", align_corners=False)
        return bicubic + F.pixel_shuffle(pixels, self.shuffle_factor), next_caches
