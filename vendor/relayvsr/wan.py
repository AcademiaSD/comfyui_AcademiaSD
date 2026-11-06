# Copyright 2025 The Wan Team and The HuggingFace Team. All rights reserved.
# Modified for RelayVSR: streaming inference, sparse conditioning, and spatial attention.
# Modified for ComfyUI by Academia SD: streaming path only, on comfy.ops layers.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import math

import comfy.model_management
import torch
import torch.nn.functional as F
from torch import nn

from .attention import local_attention


class KVRing:
    """Keys and values of the last frames of one block, written in place."""

    def __init__(self, window_size, device):
        self.window_size = window_size
        self.device = device
        self.key = None
        self.value = None

    def update(self, key, value, frame):
        tokens = key.shape[1]
        if self.key is None:
            shape = (key.shape[0], self.window_size * tokens, *key.shape[2:])
            self.key = key.new_empty(shape, device=self.device)
            self.value = value.new_empty(shape, device=self.device)
        start = (frame % self.window_size) * tokens
        self.key[:, start : start + tokens].copy_(key)
        self.value[:, start : start + tokens].copy_(value)
        valid = min(frame + 1, self.window_size) * tokens
        return self.key[:, :valid].to(key.device), self.value[:, :valid].to(key.device)


class WanStream:
    """Temporary state of one upscale run: prompt conditioning and KV history."""

    def __init__(self, model, prompt_embeds, timestep, history_device):
        self.temb, self.timestep_proj, self.text_kv = model.embed_conditioning(prompt_embeds, timestep)
        self.rings = [KVRing(model.temporal_context_frames, history_device) for _ in model.blocks]
        self.rope = model.rope_tables(prompt_embeds.device)
        self.attention_plans = {}
        self.frame = 0


def _rotate(hidden_states, cos, sin):
    x1, x2 = hidden_states.unflatten(-1, (-1, 2)).unbind(-1)
    cos, sin = cos[..., 0::2], sin[..., 1::2]
    out = torch.empty_like(hidden_states)
    out[..., 0::2] = x1 * cos - x2 * sin
    out[..., 1::2] = x1 * sin + x2 * cos
    return out


def _timestep_embedding(timestep, channels):
    half = channels // 2
    exponent = -math.log(10000) * torch.arange(half, dtype=torch.float32, device=timestep.device) / half
    angles = timestep[:, None].float() * exponent.exp()
    return torch.cat((angles.cos(), angles.sin()), dim=-1)


class FP32LayerNorm(nn.Module):
    """Float32 LayerNorm whose scale and bias are stored at another dtype."""

    def __init__(self, dim, eps):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.empty(dim))
        self.bias = nn.Parameter(torch.empty(dim))

    def forward(self, x):
        weight = comfy.model_management.cast_to(self.weight, torch.float32, x.device)
        bias = comfy.model_management.cast_to(self.bias, torch.float32, x.device)
        return F.layer_norm(x, weight.shape, weight, bias, self.eps)


class WanAttention(nn.Module):
    def __init__(self, dim, heads, eps, operations):
        super().__init__()
        self.heads = heads
        self.to_q = operations.Linear(dim, dim)
        self.to_k = operations.Linear(dim, dim)
        self.to_v = operations.Linear(dim, dim)
        self.to_out = nn.ModuleList([operations.Linear(dim, dim)])
        self.norm_q = operations.RMSNorm(dim, eps=eps)
        self.norm_k = operations.RMSNorm(dim, eps=eps)

    def key_value(self, hidden_states):
        key = self.norm_k(self.to_k(hidden_states)).unflatten(2, (self.heads, -1))
        return key, self.to_v(hidden_states).unflatten(2, (self.heads, -1))

    def _query(self, hidden_states):
        return self.norm_q(self.to_q(hidden_states)).unflatten(2, (self.heads, -1))

    def _output(self, hidden_states):
        return self.to_out[0](hidden_states.flatten(2, 3))

    def forward_self(self, hidden_states, ring, rope, spatial, stream):
        key, value = self.key_value(hidden_states)
        query = self._query(hidden_states)
        key, value = ring.update(key, value, stream.frame)
        query_rope, key_rope = rope
        query = _rotate(query, *query_rope).to(value.dtype)
        key = _rotate(key, *key_rope).to(value.dtype)
        if spatial is None:
            attended = F.scaled_dot_product_attention(query.transpose(1, 2), key.transpose(1, 2), value.transpose(1, 2)).transpose(1, 2)
        else:
            attended = local_attention(
                query[0].transpose(0, 1),
                key[0].transpose(0, 1),
                value[0].transpose(0, 1),
                shifted=True,
                plans=stream.attention_plans,
                **spatial,
            ).transpose(0, 1)[None]
        return self._output(attended)

    def forward_cross(self, hidden_states, key, value):
        query = self._query(hidden_states)
        attended = F.scaled_dot_product_attention(query.transpose(1, 2), key.transpose(1, 2), value.transpose(1, 2)).transpose(1, 2)
        return self._output(attended)


class ApproximateGELU(nn.Module):
    def __init__(self, dim, inner_dim, operations):
        super().__init__()
        self.proj = operations.Linear(dim, inner_dim)

    def forward(self, x):
        return F.gelu(self.proj(x), approximate="tanh")


class FeedForward(nn.Module):
    def __init__(self, dim, inner_dim, operations):
        super().__init__()
        self.net = nn.ModuleList([ApproximateGELU(dim, inner_dim, operations), nn.Identity(), operations.Linear(inner_dim, dim)])

    def forward(self, x):
        for module in self.net:
            x = module(x)
        return x


class WanBlock(nn.Module):
    def __init__(self, dim, ffn_dim, heads, eps, operations):
        super().__init__()
        self.eps = eps
        self.attn1 = WanAttention(dim, heads, eps, operations)
        self.attn2 = WanAttention(dim, heads, eps, operations)
        self.norm2 = FP32LayerNorm(dim, eps)
        self.ffn = FeedForward(dim, ffn_dim, operations)
        self.scale_shift_table = nn.Parameter(torch.empty(1, 6, dim))

    def forward(self, hidden_states, timestep_proj, text_kv, ring, rope, spatial, stream):
        dtype = hidden_states.dtype
        shape = hidden_states.shape[-1:]
        table = comfy.model_management.cast_to(self.scale_shift_table, dtype, hidden_states.device)
        shift_msa, scale_msa, gate_msa, c_shift_msa, c_scale_msa, c_gate_msa = (
            part.squeeze(2) for part in (table.unsqueeze(0) + timestep_proj.float()).chunk(6, dim=2)
        )

        norm = F.layer_norm(hidden_states.float(), shape, eps=self.eps) * (1 + scale_msa) + shift_msa
        attn_output = self.attn1.forward_self(norm.to(dtype), ring, rope, spatial, stream)
        hidden_states = (hidden_states.float() + attn_output * gate_msa).to(dtype)

        norm = self.norm2(hidden_states.float()).to(dtype)
        hidden_states = hidden_states + self.attn2.forward_cross(norm, *text_kv)

        norm = F.layer_norm(hidden_states.float(), shape, eps=self.eps) * (1 + c_scale_msa) + c_shift_msa
        ff_output = self.ffn(norm.to(dtype))
        return (hidden_states.float() + ff_output.float() * c_gate_msa).to(dtype)


class TimeEmbedder(nn.Module):
    def __init__(self, in_channels, dim, operations):
        super().__init__()
        self.linear_1 = operations.Linear(in_channels, dim)
        self.linear_2 = operations.Linear(dim, dim)

    def forward(self, x):
        return self.linear_2(F.silu(self.linear_1(x)))


class TextEmbedder(nn.Module):
    def __init__(self, in_channels, dim, operations):
        super().__init__()
        self.linear_1 = operations.Linear(in_channels, dim)
        self.linear_2 = operations.Linear(dim, dim)

    def forward(self, x):
        return self.linear_2(F.gelu(self.linear_1(x), approximate="tanh"))


class ConditionEmbedder(nn.Module):
    def __init__(self, dim, freq_dim, text_dim, operations):
        super().__init__()
        self.freq_dim = freq_dim
        self.time_embedder = TimeEmbedder(freq_dim, dim, operations)
        self.time_proj = operations.Linear(dim, dim * 6)
        self.text_embedder = TextEmbedder(text_dim, dim, operations)


class RMSNorm2d(nn.Module):
    """RMSNorm over the channels of [B,C,H,W], in float32 like the upstream."""

    def __init__(self, dim, eps=1e-6):
        super().__init__()
        self.weight = nn.Parameter(torch.empty(dim, 1, 1))
        self.eps = eps

    def forward(self, x):
        dtype = x.dtype
        x = x.float()
        x = x * torch.rsqrt(x.square().mean(dim=1, keepdim=True) + self.eps)
        return (x * comfy.model_management.cast_to(self.weight, torch.float32, x.device)).to(dtype)


class LQProjection(nn.Module):
    def __init__(self, out_dim, hidden_dim1, hidden_dim2, operations):
        super().__init__()
        self.conv1 = operations.Conv2d(3 * 16 * 16, hidden_dim1, kernel_size=1)
        self.norm1 = RMSNorm2d(hidden_dim1)
        self.conv2 = operations.Conv2d(hidden_dim1, hidden_dim2, kernel_size=3, stride=2, padding=1)
        self.norm2 = RMSNorm2d(hidden_dim2)
        self.out_proj = operations.Linear(hidden_dim2, out_dim)

    def forward(self, frame):
        x = F.pixel_unshuffle(frame, 16)
        x = F.silu(self.norm1(self.conv1(x)))
        x = F.silu(self.norm2(self.conv2(x)))
        return self.out_proj(x.flatten(2).transpose(1, 2))


class WanKeyframeModel(nn.Module):
    """One-step Wan 2.2 TI2V transformer that turns an LR frame into a keyframe latent."""

    def __init__(self, config, operations):
        super().__init__()
        heads = config["num_attention_heads"]
        self.head_dim = config["attention_head_dim"]
        dim = heads * self.head_dim
        self.eps = config["eps"]
        self.in_channels = config["in_channels"]
        self.patch_size = tuple(config["patch_size"])
        self.temporal_context_frames = config["temporal_context_frames"]
        self.training_frames = config["temporal_rope"]["training_frames"]
        self.rope_max_seq_len = config["rope_max_seq_len"]
        self.spatial_window = tuple(config["spatial_window_size"])

        self.patch_embedding = operations.Conv3d(self.in_channels, dim, kernel_size=self.patch_size, stride=self.patch_size)
        self.condition_embedder = ConditionEmbedder(dim, config["freq_dim"], config["text_dim"], operations)
        self.blocks = nn.ModuleList(
            [WanBlock(dim, config["ffn_dim"], heads, self.eps, operations) for _ in range(config["num_layers"])]
        )
        self.proj_out = operations.Linear(dim, config["out_channels"] * math.prod(self.patch_size))
        self.scale_shift_table = nn.Parameter(torch.empty(1, 2, dim))
        self.lq_proj = LQProjection(dim, config["lq_proj_hidden_dim1"], config["lq_proj_hidden_dim2"], operations)

    def embed_conditioning(self, prompt_embeds, timestep):
        embedder = self.condition_embedder
        temb = embedder.time_embedder(_timestep_embedding(timestep, embedder.freq_dim).to(prompt_embeds.dtype))
        timestep_proj = embedder.time_proj(F.silu(temb)).unflatten(-1, (6, -1))
        text = embedder.text_embedder(prompt_embeds)
        return temb[None], timestep_proj[None], [block.attn2.key_value(text) for block in self.blocks]

    def rope_tables(self, device):
        h_dim = w_dim = 2 * (self.head_dim // 6)
        t_dim = self.head_dim - h_dim - w_dim
        dtype = torch.float32 if torch.backends.mps.is_available() else torch.float64
        positions = torch.arange(self.rope_max_seq_len, device=device, dtype=dtype)
        tables = []
        for size in (t_dim, h_dim, w_dim):
            angles = torch.outer(positions, 1.0 / (10000.0 ** (torch.arange(0, size, 2, device=device, dtype=dtype) / size)))
            tables.append((angles.cos().repeat_interleave(2, dim=1).float(), angles.sin().repeat_interleave(2, dim=1).float()))
        return tables

    def _rope(self, tables, height, width, positions):
        frames = len(positions)
        temporal = torch.tensor(positions, device=tables[0][0].device)
        parts = []
        for index in (0, 1):
            f = tables[0][index][temporal].view(frames, 1, 1, -1).expand(frames, height, width, -1)
            h = tables[1][index][:height].view(1, height, 1, -1).expand(frames, height, width, -1)
            w = tables[2][index][:width].view(1, 1, width, -1).expand(frames, height, width, -1)
            parts.append(torch.cat((f, h, w), dim=-1).reshape(1, frames * height * width, 1, -1))
        return tuple(parts)

    def forward(self, lq_frame, latent, stream):
        """lq_frame [1,3,H,W], latent [1,C,1,H/16,W/16]; returns the latent velocity."""
        _, patch_h, patch_w = self.patch_size
        grid_h, grid_w = latent.shape[-2] // patch_h, latent.shape[-1] // patch_w
        frame = stream.frame
        window = self.temporal_context_frames
        valid = min(frame + 1, window)
        origin = max(0, frame - self.training_frames + 1)
        # Slots of the ring are stable; RoPE follows the true frame in each one.
        frame_ids = tuple(frame - ((frame - slot) % window) for slot in range(valid))
        rope = (
            self._rope(stream.rope, grid_h, grid_w, (frame - origin,)),
            self._rope(stream.rope, grid_h, grid_w, tuple(index - origin for index in frame_ids)),
        )
        window_h, window_w = self.spatial_window
        spatial = None
        if window_h < grid_h or window_w < grid_w:
            spatial = {"height": grid_h, "width": grid_w, "planes": tuple((plane, window_h, window_w) for plane in range(valid))}

        hidden_states = self.patch_embedding(latent).flatten(2).transpose(1, 2)
        hidden_states = hidden_states + self.lq_proj(lq_frame)
        for block, ring, text_kv in zip(self.blocks, stream.rings, stream.text_kv):
            hidden_states = block(hidden_states, stream.timestep_proj, text_kv, ring, rope, spatial, stream)

        table = comfy.model_management.cast_to(self.scale_shift_table, stream.temb.dtype, stream.temb.device)
        shift, scale = (table.unsqueeze(0) + stream.temb.unsqueeze(2)).chunk(2, dim=2)
        norm = F.layer_norm(hidden_states.float(), hidden_states.shape[-1:], eps=self.eps) * (1 + scale.squeeze(2)) + shift.squeeze(2)
        hidden_states = self.proj_out(norm.to(hidden_states.dtype))

        stream.frame += 1
        hidden_states = hidden_states.reshape(1, grid_h, grid_w, patch_h, patch_w, -1).permute(0, 5, 1, 3, 2, 4)
        return hidden_states.flatten(4, 5).flatten(2, 3).unsqueeze(2)
