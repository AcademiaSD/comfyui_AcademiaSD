# -*- coding: utf-8 -*-
"""Before / After: compara dos videos o imagenes con una cortinilla.
/ Before / After: compares two videos or images with a sliding wipe.

El nodo tiene un visor con una cortinilla que se arrastra (js/academia_before_after.js)
y ademas devuelve un video con la cortinilla animada, listo para Video Combine.
Los dos lados del visor viajan en un unico MP4, uno junto al otro: asi van siempre
fotograma a fotograma, cosa que dos <video> separados no garantizan.

The viewer plays one side-by-side MP4 so both sides stay frame-locked, and the node
also outputs a video with the wipe animated.
"""

import os
import uuid
from fractions import Fraction

import av
import folder_paths
import numpy as np
import torch
import torch.nn.functional as F

PREVIEW_WIDTH = 1280
DIRECTIONS = ["right_to_left", "left_to_right"]


def _resize(frame, height, width):
    if frame.shape[:2] == (height, width):
        return frame
    x = frame.permute(2, 0, 1).unsqueeze(0)
    return F.interpolate(x, size=(height, width), mode="bicubic", antialias=True)[0].permute(1, 2, 0).clamp(0.0, 1.0)


def _wipe_progress(index, wipe_frames):
    """Avance de la cortinilla, 0 a 1, con arranque y final suaves."""
    if wipe_frames < 2:
        return 0.5
    t = min(index / (wipe_frames - 1), 1.0)
    return t * t * (3.0 - 2.0 * t)


def _save_preview(before, after, fps, height, width):
    """MP4 temporal con before a la izquierda y after a la derecha."""
    scale = min(1.0, PREVIEW_WIDTH / width)
    side_h, side_w = round(height * scale / 2) * 2, round(width * scale / 2) * 2
    name = f"asd_before_after_{uuid.uuid4().hex[:12]}.mp4"
    container = av.open(os.path.join(folder_paths.get_temp_directory(), name), mode="w")
    stream = container.add_stream("libx264", rate=Fraction(fps).limit_denominator(1001))
    stream.width, stream.height, stream.pix_fmt = side_w * 2, side_h, "yuv420p"
    stream.options = {"crf": "17", "preset": "veryfast"}
    for index in range(max(len(before), len(after))):
        sides = (_resize(batch[min(index, len(batch) - 1)][..., :3], side_h, side_w) for batch in (before, after))
        pixels = torch.cat(tuple(sides), dim=1).mul(255.0).round().byte().numpy().astype(np.uint8)
        for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format="rgb24")):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()
    return {"filename": name, "subfolder": "", "type": "temp"}


class AcademiaBeforeAfter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "before": ("IMAGE",),
                "after": ("IMAGE",),
                "direction": (DIRECTIONS, {"default": "right_to_left", "tooltip": "Which way the wipe of the output video travels."}),
                "wipe_frames": ("INT", {"default": 0, "min": 0, "max": 100000, "tooltip": "Length of the wipe in the output video. 0 uses the whole clip. With two images, the output lasts this many frames."}),
                "line_width": ("INT", {"default": 3, "min": 0, "max": 64, "tooltip": "Width in pixels of the white line of the output video."}),
                "fps": ("FLOAT", {"default": 24.0, "min": 0.1, "max": 240.0, "step": 0.01, "tooltip": "Playback speed of the viewer in the node."}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("wipe_video",)
    FUNCTION = "compare"
    OUTPUT_NODE = True
    CATEGORY = "Academia SD"
    DESCRIPTION = "Compares two videos or images with a draggable wipe, and outputs a video with the wipe animated."

    def compare(self, before, after, direction, wipe_frames, line_width, fps):
        height, width = after.shape[1:3]
        frames = max(len(before), len(after), wipe_frames)
        wipe = wipe_frames or frames
        output = torch.empty((frames, height, width, 3), dtype=torch.float32)
        for index in range(frames):
            old = _resize(before[min(index, len(before) - 1)][..., :3], height, width)
            new = after[min(index, len(after) - 1)][..., :3]
            progress = _wipe_progress(index, wipe)
            if direction == "right_to_left":
                x = round(width * (1.0 - progress))
                output[index, :, :x] = old[:, :x]
                output[index, :, x:] = new[:, x:]
            else:
                x = round(width * progress)
                output[index, :, :x] = new[:, :x]
                output[index, :, x:] = old[:, x:]
            if 0 < x < width:
                output[index, :, max(0, x - line_width // 2) : x + (line_width + 1) // 2] = 1.0
        return {"ui": {"asd_preview": [_save_preview(before, after, fps, height, width)], "asd_fps": [fps]}, "result": (output,)}


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_BeforeAfter": AcademiaBeforeAfter,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_BeforeAfter": "Academia SD Before / After 🪟",
}
