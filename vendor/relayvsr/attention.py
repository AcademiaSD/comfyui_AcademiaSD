"""Windowed attention over a token grid, in tiles of queries sharing their key rectangle.

Replaces the Triton kernels of RelayVSR with the same masks: a query sees, in each key
plane, the window centred on it. shifted=True moves the window inward at the borders
(Wan); shifted=False truncates it (Flash).
"""

import torch

TILE = 8
CHUNK_BYTES = 128 * 1024**2


def _rectangle(origin, size, limit, shifted):
    if shifted:
        size = min(size, limit)
        return (origin - size // 2).clamp(0, limit - size), size
    return origin - size // 2, size


def _chunk_plan(tile_y, tile_x, height, width, planes, shifted):
    device = tile_y.device
    offset = torch.arange(TILE, device=device)
    query_y = (tile_y[:, None, None] + offset[:, None]).expand(-1, TILE, TILE).flatten(1)
    query_x = (tile_x[:, None, None] + offset[None, :]).expand(-1, TILE, TILE).flatten(1)
    query_valid = (query_y < height) & (query_x < width)
    tokens = height * width

    indices, masks = [], []
    for plane, window_h, window_w in planes:
        base_top, window_h = _rectangle(tile_y, window_h, height, shifted)
        base_left, window_w = _rectangle(tile_x, window_w, width, shifted)
        top, _ = _rectangle(query_y, window_h, height, shifted)
        left, _ = _rectangle(query_x, window_w, width, shifted)
        rows = torch.arange(window_h + TILE - 1, device=device)
        cols = torch.arange(window_w + TILE - 1, device=device)
        key_y = (base_top[:, None, None] + rows[:, None]).expand(-1, -1, cols.numel()).flatten(1)
        key_x = (base_left[:, None, None] + cols[None, :]).expand(-1, rows.numel(), -1).flatten(1)
        key_valid = (key_y >= 0) & (key_y < height) & (key_x >= 0) & (key_x < width)
        indices.append(plane * tokens + key_y.clamp(0, height - 1) * width + key_x.clamp(0, width - 1))
        masks.append(
            key_valid[:, None]
            & (key_y[:, None] >= top[:, :, None])
            & (key_y[:, None] < top[:, :, None] + window_h)
            & (key_x[:, None] >= left[:, :, None])
            & (key_x[:, None] < left[:, :, None] + window_w)
        )
    query_index = query_y.clamp(0, height - 1) * width + query_x.clamp(0, width - 1)
    return query_index, query_valid, torch.cat(indices, dim=1), torch.cat(masks, dim=2)


def local_attention(query, key, value, *, height, width, planes, shifted, plans):
    """Q=[Hq,N,D], K/V=[Hk,P*N,D], N=height*width, Hk divides Hq (grouped queries).

    planes holds (plane, window_h, window_w). plans caches the index tensors of each
    geometry and belongs to the caller for the duration of a run.
    """
    plan_key = (height, width, planes, shifted)
    chunks = plans.get(plan_key)
    if chunks is None:
        origins = [(y, x) for y in range(0, height, TILE) for x in range(0, width, TILE)]
        keys = sum((window_h + TILE - 1) * (window_w + TILE - 1) for _, window_h, window_w in planes)
        kv_bytes = key.shape[0] * key.shape[-1] * (torch.float32.itemsize + value.dtype.itemsize)
        score_bytes = TILE**2 * query.shape[0] * 2 * torch.float32.itemsize
        tile_bytes = keys * (kv_bytes + score_bytes)
        chunk_tiles = max(1, CHUNK_BYTES // tile_bytes)
        chunks = []
        for start in range(0, len(origins), chunk_tiles):
            tile_y, tile_x = zip(*origins[start : start + chunk_tiles])
            chunks.append(
                _chunk_plan(
                    torch.tensor(tile_y, device=query.device),
                    torch.tensor(tile_x, device=query.device),
                    height,
                    width,
                    planes,
                    shifted,
                )
            )
        plans[plan_key] = chunks

    heads_k = key.shape[0]
    groups = query.shape[0] // heads_k
    output = torch.empty_like(query)
    scale = query.shape[-1] ** -0.5
    for query_index, query_valid, key_index, mask in chunks:
        # Scores in float32 like the upstream kernels: BF16 here costs 5 dB against FP32.
        q = query[:, query_index].unflatten(0, (heads_k, groups)).float()
        k = key[:, key_index].unsqueeze(1).float()
        scores = torch.matmul(q, k.mT).mul_(scale)
        scores.masked_fill_(~mask, -torch.inf)
        probabilities = scores.softmax(dim=-1).to(value.dtype)
        attended = torch.matmul(probabilities, value[:, key_index].unsqueeze(1)).flatten(0, 1)
        output[:, query_index[query_valid]] = attended[:, query_valid]
    return output
