# -*- coding: utf-8 -*-
"""RelayVSR: reescalado de video x4 con la colaboracion de dos modelos.
/ RelayVSR: 4x video super-resolution with two collaborating models.

Wan (grande) genera un latente de referencia cada window_size-1 fotogramas y
Flash (pequeno) reescala todos los fotogramas entre dos referencias. Aqui las
dos fases van una detras de otra, porque ya tenemos todo el video: asi Wan sale
de la VRAM antes de que entre Flash, algo clave en graficas de 8-12 GB.

Wan generates a reference latent every window_size-1 frames and Flash upscales
every frame between two references. Both phases run in sequence, so Wan can
leave VRAM before Flash needs it.

Modelo original: https://github.com/kopperx/RelayVSR (Apache-2.0).
Port en vendor/relayvsr/ / Port in vendor/relayvsr/.
"""

import asyncio
import hashlib
import importlib
import importlib.util
import json
import logging
import os
import shutil
import sys
import time
import uuid
from fractions import Fraction
from itertools import islice
from pathlib import Path

import av
import comfy.model_management
import comfy.model_patcher
import comfy.ops
import comfy.storage
import comfy.utils
import folder_paths
import nodes
import torch
import torch.nn.functional as F
from aiohttp import web
from comfy.utils import ProgressBar
from comfy_api.latest import InputImpl
from safetensors.torch import save_file
from server import PromptServer

_VENDOR = Path(__file__).resolve().parent.parent / "vendor" / "relayvsr"
_PACKAGE = "academiasd_relayvsr"
if _PACKAGE not in sys.modules:
    _spec = importlib.util.spec_from_file_location(_PACKAGE, _VENDOR / "__init__.py", submodule_search_locations=[str(_VENDOR)])
    sys.modules[_PACKAGE] = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(sys.modules[_PACKAGE])
_wan = importlib.import_module(f"{_PACKAGE}.wan")
_flash = importlib.import_module(f"{_PACKAGE}.flash")

SCALE = 4
LATENT_STRIDE = 8  # LR pixels of one Wan token (32 px at x4)
WAN_LATENT_SCALE = 16  # HR pixels of one latent cell
WAN_TIMESTEP = 1000.0
NATIVE_MAX_WINDOW = 16  # VSR Decode only takes two keyframes per call up to this many frames
# En una sola pasada los fotogramas de todas las referencias van a la VRAM y a 5K la
# llenan con 25. Por lotes el coste no depende de la duracion: 32768 tokens es el tope
# por tramo del modelo nativo, y las 3 referencias previas mantienen su contexto.
WAN_PASS_TOKENS = 32768
WAN_CONTEXT = 3
MP4_AUDIO_CODECS = ("aac", "mp3", "mp3float", "ac3", "eac3", "opus", "flac", "alac")


class RelayVSRModel:
    def __init__(self, wan, flash, prompt_embeds, dtype):
        self.wan = wan
        self.flash = flash
        self.prompt_embeds = prompt_embeds
        self.dtype = dtype


def _read_checkpoint(name, expected_format):
    path = folder_paths.get_full_path_or_raise("diffusion_models", name)
    sd, metadata = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
    if (metadata or {}).get("format") != expected_format:
        raise ValueError(f"{name} is not a RelayVSR checkpoint ({expected_format}). Download it from huggingface.co/kopper/RelayVSR.")
    return sd, json.loads(metadata["config"])


def _patcher(model, sd, device, offload_device):
    return comfy.model_patcher.CoreModelPatcher(
        model.eval(), load_device=device, offload_device=offload_device, fast_disk=comfy.storage.state_dict_fast_disk(sd)
    )


def _prepare_lr(frame, device, dtype):
    """IMAGE [H,W,3] -> [1,3,H,W] in [-1,1], replicated up to the Wan grid."""
    x = frame[..., :3].to(device, non_blocking=True).permute(2, 0, 1).unsqueeze(0) * 2.0 - 1.0
    height, width = x.shape[-2:]
    return F.pad(x, (0, -width % LATENT_STRIDE, 0, -height % LATENT_STRIDE), mode="replicate").to(dtype)


def _keyframe_indices(frames, window_size):
    indices = [0]
    while indices[-1] < frames - 1:
        indices.append(min(indices[-1] + window_size - 1, frames - 1))
    return indices


def _wan_history_size(height, width, dtype):
    tokens = height * SCALE * width * SCALE // (2 * WAN_LATENT_SCALE) ** 2
    return 4 * 30 * 2 * tokens * 3072 * dtype.itemsize


def _flash_memory(height, width, dtype):
    tokens = height * width // 16
    history = 10 * 4 * 2 * 2 * tokens * 64 * dtype.itemsize
    output = height * width * SCALE**2 * 3 * 4
    return int(history * 1.5) + output * 3 + 3 * 1024**3


def _sample_keyframes(model, frames, height, width, seed, progress):
    """One-step Wan: noise minus velocity, one latent per frame of an iterable of keyframes."""
    patcher = model.wan
    device = patcher.load_device
    dtype = model.dtype
    # The KV history of Wan grows with the image and would push its weights out of a
    # small card; in RAM it only costs some transfers per keyframe.
    history = _wan_history_size(height + -height % LATENT_STRIDE, width + -width % LATENT_STRIDE, dtype)
    history_fits = history < comfy.model_management.get_total_memory(device) / 4
    comfy.model_management.load_models_gpu([patcher], memory_required=2 * 1024**3 + (history if history_fits else 0))
    wan = patcher.model
    prompt = model.prompt_embeds.to(device, dtype)
    timestep = torch.tensor([WAN_TIMESTEP], device=device)
    stream = _wan.WanStream(wan, prompt, timestep, device if history_fits else patcher.offload_device)
    generator = torch.Generator(device=device).manual_seed(seed)
    latents = []
    for frame in frames:
        comfy.model_management.throw_exception_if_processing_interrupted()
        lr = _prepare_lr(frame, device, dtype)
        lq = F.interpolate(lr, scale_factor=SCALE, mode="bilinear", align_corners=False)
        shape = (1, wan.in_channels, 1, lq.shape[-2] // WAN_LATENT_SCALE, lq.shape[-1] // WAN_LATENT_SCALE)
        noise = torch.randn(shape, generator=generator, device=device, dtype=torch.float32)
        velocity = wan(lq, noise.to(dtype), stream)
        latents.append((noise - velocity.float())[:, :, 0].to(dtype))
        progress.update(1)
    return latents


def _load_flash(model, height, width):
    comfy.model_management.load_models_gpu([model.flash], memory_required=_flash_memory(height, width, model.dtype))
    return model.flash.model, _flash.FlashStream()


def _windows(flash, stream, indices, latents, first_slot=1):
    """(start, end, conditions) of each window, sharing the keyframe between neighbours."""
    last = len(indices) - 1
    start_condition = flash.prepare_condition(latents[first_slot - 1], stream)
    for slot in range(first_slot, max(last + 1, 2)):
        end_condition = flash.prepare_condition(latents[slot], stream) if slot <= last else start_condition
        yield indices[slot - 1], indices[min(slot, last)], flash.merge_conditions(start_condition, end_condition)
        start_condition = end_condition


def _decode_window(flash, stream, frames, conditions, skip_first, output_size, dtype):
    """Yields IMAGE frames; a shared keyframe only feeds the history of the second window."""
    device = next(flash.parameters()).device
    height, width = frames[0].shape[:2]
    video_caches = [None] * len(conditions)
    for offset, frame in enumerate(frames):
        comfy.model_management.throw_exception_if_processing_interrupted()
        prediction, video_caches = flash.decode_step(_prepare_lr(frame, device, dtype), video_caches, conditions, stream)
        if offset or not skip_first:
            image = prediction[..., : height * SCALE, : width * SCALE].float().add_(1.0).mul_(0.5).clamp_(0.0, 1.0)
            if tuple(image.shape[-2:]) != output_size:
                image = F.interpolate(image, size=output_size, mode="bicubic", antialias=True).clamp_(0.0, 1.0)
            yield image[0].permute(1, 2, 0).cpu()


def _decode_images(model, images, indices, latents, output_size, progress):
    frames, height, width = images.shape[:3]
    flash, stream = _load_flash(model, height, width)
    output = torch.empty((frames, *output_size, 3), dtype=torch.float32)
    for start, end, conditions in _windows(flash, stream, indices, latents):
        window = images[start : end + 1]
        first = start + 1 if start else 0
        for index, image in enumerate(_decode_window(flash, stream, window, conditions, start > 0, output_size, model.dtype), first):
            output[index] = image
            progress.update(1)
    return output


def _resize_output(image, output_size):
    if tuple(image.shape[:2]) == output_size:
        return image
    x = image.permute(2, 0, 1).unsqueeze(0)
    return F.interpolate(x, size=output_size, mode="bicubic", antialias=True)[0].permute(1, 2, 0).clamp_(0.0, 1.0)


def _iter_video(path, height, width):
    """IMAGE frames of a video file, one at a time."""
    with av.open(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        for frame in container.decode(stream):
            rgb = frame.reformat(width=width, height=height, format="rgb24", interpolation="BICUBIC")
            yield torch.from_numpy(rgb.to_ndarray().copy()).float().div_(255.0)


def _iter_keyframes(frames, step, count):
    """Keyframes of a clip of unknown length: the last frame is only known at the end."""
    index, frame = -1, None
    for index, frame in enumerate(frames):
        if index % step == 0:
            yield frame
    count.append(index + 1)
    if index % step:
        yield frame


def _write_part(path, frames, fps, crf):
    temporary = f"{path}.tmp.mp4"
    container = av.open(temporary, mode="w")
    try:
        stream = None
        for image in frames:
            if stream is None:
                stream = container.add_stream("libx264", rate=fps)
                stream.height, stream.width = image.shape[:2]
                stream.pix_fmt = "yuv420p"
                stream.options = {"crf": str(crf), "preset": "medium"}
            pixels = image.mul(255.0).round().byte().numpy()
            for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    finally:
        container.close()
    os.replace(temporary, path)


def _mp4_audio(source, path):
    """The file to take the audio from: the source, or an AAC copy when its audio does not fit in MP4, like the PCM of many AVI."""
    with av.open(source) as original:
        if not original.streams.audio or original.streams.audio[0].codec_context.name in MP4_AUDIO_CODECS:
            return source
        audio_in = original.streams.audio[0]
        with av.open(path, mode="w") as converted:
            audio = converted.add_stream("aac", rate=audio_in.rate, layout="mono" if audio_in.channels == 1 else "stereo")
            for frame in original.decode(audio_in):
                converted.mux(audio.encode(frame))
            converted.mux(audio.encode(None))
    return path


def _join_parts(parts, source, output, fps, frames):
    """Remuxes the parts and the audio of the source without encoding them again."""
    with av.open(output, mode="w") as joined, av.open(source) as original:
        video = None
        audio_in = original.streams.audio[0] if original.streams.audio else None
        audio = joined.add_stream_from_template(audio_in) if audio_in is not None else None
        audio_packets = iter(original.demux(audio_in)) if audio is not None else iter(())
        audio_start = None
        pending = None
        written = 0
        for path in parts:
            with av.open(path) as part:
                part_stream = part.streams.video[0]
                if video is None:
                    video = joined.add_stream_from_template(part_stream)
                offset = round(Fraction(written) / fps / part_stream.time_base)
                for packet in part.demux(part_stream):
                    if packet.dts is None:
                        continue
                    packet.pts += offset
                    packet.dts += offset
                    packet.stream = video
                    joined.mux(packet)
                written += part_stream.frames
            limit = Fraction(min(written, frames)) / fps
            while audio is not None:
                packet = pending if pending is not None else next(audio_packets, None)
                pending = None
                if packet is None:
                    break
                if packet.dts is None:
                    continue
                if audio_start is None:
                    audio_start = packet.dts
                if (packet.dts - audio_start) * packet.time_base >= limit:
                    pending = packet
                    break
                packet.pts -= audio_start
                packet.dts -= audio_start
                packet.stream = audio
                joined.mux(packet)


class _JobProgress:
    """Estado de las dos barras de js/academia_relayvsr_progress.js.
    / State of the total and part bars in the node."""

    def __init__(self, node_id, frames):
        self.state = {"node": node_id, "phase": "wan", "frames": frames, "frames_done": 0, "part": 0, "parts": 0, "part_done": 0, "part_size": 0, "eta": None}
        self.started = time.time()
        self.resumed_frames = 0

    def _send(self):
        PromptServer.instance.send_sync("asd_relayvsr_progress", self.state, PromptServer.instance.client_id)

    def references(self, count):
        self.state["part_size"] = count
        self._send()

    def update(self, count):
        self.state["part_done"] += count
        if self.state["phase"] == "parts":
            self.state["frames_done"] += count
            remaining = self.state["frames"] - self.state["frames_done"]
            self.state["eta"] = remaining * (time.time() - self.started) / max(1, self.state["frames_done"] - self.resumed_frames)
        self._send()

    def start_parts(self, frames, frames_done, parts):
        self.started = time.time()
        self.resumed_frames = frames_done
        self.state.update(phase="parts", frames=frames, frames_done=frames_done, parts=parts)

    def start_part(self, index, size):
        self.state.update(part=index + 1, part_done=0, part_size=size)
        self._send()

    def finish_phase(self, phase):
        self.state.update(phase=phase, eta=None, frames_done=self.state["frames"])
        self._send()


def _probe_video(source):
    with av.open(source) as container:
        stream = container.streams.video[0]
        estimate = stream.frames or round(float(stream.duration * stream.time_base * stream.average_rate))
        return Fraction(stream.average_rate), stream.height, stream.width, estimate


def _input_size(source_h, source_w, input_height):
    if not input_height:
        return source_h, source_w
    return input_height, round(source_w * input_height / source_h / 2) * 2


def _even_size(height, width, scale):
    return round(height * scale / 2) * 2, round(width * scale / 2) * 2


def _upscale_file(source, settings, size, window_size, segment_seconds, crf, filename_prefix, node_id, sample_keyframes, decode_windows):
    """Lee y escribe en disco, asi que la RAM no crece con la duracion. Cada ventana de
    Flash empieza de cero, de modo que una parte terminada es definitiva y se puede
    reanudar en la ventana siguiente sin costura.

    Disk to disk, resumable at window boundaries without seams. sample_keyframes(keyframes,
    done, progress) yields lists of new latents, skipping the first `done` keyframes;
    decode_windows(indices, latents, first_slot, read_window) yields the output frames of
    the windows from first_slot on."""
    fps, _, _, estimate = _probe_video(source)
    height, width = size
    step = window_size - 1

    info = os.stat(source)
    job = (os.path.basename(source), info.st_size, info.st_mtime_ns, size, window_size, segment_seconds, crf, settings)
    name = hashlib.sha1(repr(job).encode()).hexdigest()[:12]
    parts_dir = os.path.join(folder_paths.get_output_directory(), "RelayVSR_parts", f"{Path(source).stem}_{name}")
    os.makedirs(parts_dir, exist_ok=True)
    logging.info(f"[RelayVSR] {Path(source).name}: {width}x{height}, parts in {parts_dir}")

    progress = _JobProgress(node_id, estimate)
    latents_path = os.path.join(parts_dir, "latents.safetensors")
    if os.path.exists(latents_path):
        saved, metadata = comfy.utils.load_torch_file(latents_path, safe_load=True, return_metadata=True)
        frames = int(metadata["frames"])
        latents = [saved[str(index)] for index in range(len(saved))]
    else:
        progress.references(-(-(estimate - 1) // step) + 1)
        latents = []
        batches = []
        while os.path.exists(path := os.path.join(parts_dir, f"refs_{len(batches):05}.safetensors")):
            saved = comfy.utils.load_torch_file(path, safe_load=True)
            latents += [saved[str(index)] for index in range(len(saved))]
            batches.append(path)
        progress.update(len(latents))
        count = []
        keyframes = _iter_keyframes(_iter_video(source, height, width), step, count)
        for new in sample_keyframes(keyframes, len(latents), progress):
            new = [latent.cpu() for latent in new]
            path = os.path.join(parts_dir, f"refs_{len(batches):05}.safetensors")
            save_file({str(index): latent for index, latent in enumerate(new)}, f"{path}.tmp")
            os.replace(f"{path}.tmp", path)
            batches.append(path)
            latents += new
        frames = count[0]
        save_file({str(index): latent for index, latent in enumerate(latents)}, latents_path, metadata={"frames": str(frames)})
        for path in batches:
            os.remove(path)
        comfy.model_management.soft_empty_cache()

    indices = _keyframe_indices(frames, window_size)
    slots = max(len(indices) - 1, 1)
    slots_per_part = max(1, round(segment_seconds * fps / step))
    part_count = -(-slots // slots_per_part)
    parts = [os.path.join(parts_dir, f"part_{index:05}.mp4") for index in range(part_count)]
    finished = sum(os.path.exists(path) for path in parts)
    if finished < part_count:
        first_slot = finished * slots_per_part + 1
        start_frame = indices[first_slot - 1]
        progress.start_parts(frames, start_frame + 1 if start_frame else 0, part_count)
        source_frames = _iter_video(source, height, width)
        current = next(islice(source_frames, start_frame, None))

        def read_window(start, end):
            nonlocal current
            window = [current, *islice(source_frames, end - start)]
            current = window[-1]
            return window

        def counted(images):
            for image in images:
                progress.update(1)
                yield image

        output = counted(decode_windows(indices, latents, first_slot, read_window))
        for index in range(finished, part_count):
            last_frame = indices[min((index + 1) * slots_per_part, len(indices) - 1)]
            first_frame = indices[index * slots_per_part] + 1 if index else 0
            progress.start_part(index, last_frame - first_frame + 1)
            _write_part(parts[index], islice(output, last_frame - first_frame + 1), fps, crf)
            logging.info(f"[RelayVSR] Part {index + 1}/{part_count} done")

    progress.finish_phase("join")
    folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, folder_paths.get_output_directory())
    output_name = f"{filename}_{counter:05}_.mp4"
    output_path = os.path.join(folder, output_name)
    _join_parts(parts, _mp4_audio(source, os.path.join(parts_dir, "audio.m4a")), output_path, fps, frames)
    shutil.rmtree(parts_dir)
    progress.finish_phase("done")
    return {"ui": {"asd_video": [{"filename": output_name, "subfolder": subfolder, "type": "output"}]}, "result": (output_path, InputImpl.VideoFromFile(output_path))}


def _video_files():
    input_dir = folder_paths.get_input_directory()
    files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
    return sorted(folder_paths.filter_files_content_types(files, ["video"]))


def _validate_video(video, input_types):
    if "video_input" not in input_types and not folder_paths.exists_annotated_filepath(video):
        return f"Invalid video file: {video}"
    return True


def _source_path(video, video_input):
    """A file on disk to read: the input video, or a copy of a VIDEO that is not a plain file."""
    if video_input is None:
        return folder_paths.get_annotated_filepath(video)
    source = video_input.get_stream_source()
    if isinstance(video_input, InputImpl.VideoFromFile) and isinstance(source, str) and video_input.get_active_trim_window() == (0.0, 0.0):
        return source
    path = os.path.join(folder_paths.get_temp_directory(), f"relayvsr_input_{uuid.uuid4().hex[:12]}.mp4")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    video_input.save_to(path)
    return path


def _write_preview(source, path):
    """Small MP4 of a source the browser cannot play, such as AVI."""
    temporary = f"{path}.{uuid.uuid4().hex[:8]}.tmp.mp4"
    with av.open(source) as original, av.open(temporary, mode="w") as preview:
        video_in = original.streams.video[0]
        video_in.thread_type = "AUTO"
        height = min(360, video_in.height // 2 * 2)
        width = round(video_in.width * height / video_in.height / 2) * 2
        stream = preview.add_stream("libx264", rate=video_in.average_rate)
        stream.height, stream.width, stream.pix_fmt = height, width, "yuv420p"
        stream.options = {"crf": "28", "preset": "ultrafast"}
        for frame in original.decode(video_in):
            preview.mux(stream.encode(frame.reformat(width=width, height=height, format="yuv420p")))
        preview.mux(stream.encode(None))
    os.replace(temporary, path)


@PromptServer.instance.routes.get("/academia/relayvsr/size")
async def _size(request):
    filename = request.query.get("filename", "")
    if filename not in _video_files():
        return web.Response(status=404)
    _, height, width, _ = _probe_video(folder_paths.get_annotated_filepath(filename))
    return web.json_response({"width": width, "height": height})


@PromptServer.instance.routes.get("/academia/relayvsr/preview")
async def _preview(request):
    filename = request.query.get("filename", "")
    if filename not in _video_files():
        return web.Response(status=404)
    source = folder_paths.get_annotated_filepath(filename)
    info = os.stat(source)
    key = hashlib.sha1(repr((filename, info.st_size, info.st_mtime_ns)).encode()).hexdigest()[:12]
    path = os.path.join(folder_paths.get_temp_directory(), "relayvsr_preview", f"{key}.mp4")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        await asyncio.get_running_loop().run_in_executor(None, _write_preview, source, path)
    return web.FileResponse(path)


class AcademiaRelayVSRLoader:
    @classmethod
    def INPUT_TYPES(s):
        models = folder_paths.get_filename_list("diffusion_models")
        return {
            "required": {
                "wan_model": (models, {"tooltip": "wan.safetensors from huggingface.co/kopper/RelayVSR (10 GB), in models/diffusion_models"}),
                "flash_model": (models, {"tooltip": "flash.safetensors from huggingface.co/kopper/RelayVSR (128 MB), in models/diffusion_models"}),
            }
        }

    RETURN_TYPES = ("RELAYVSR_MODEL",)
    RETURN_NAMES = ("relayvsr_model",)
    FUNCTION = "load"
    CATEGORY = "Academia SD/RelayVSR"

    def load(self, wan_model, flash_model):
        device = comfy.model_management.get_torch_device()
        offload_device = comfy.model_management.unet_offload_device()
        dtype = comfy.model_management.unet_dtype(device, supported_dtypes=[torch.bfloat16, torch.float16, torch.float32], weight_dtype=torch.bfloat16)

        wan_sd, wan_config = _read_checkpoint(wan_model, "refvsr-wan-v1")
        prompt_embeds = wan_sd.pop("prompt_embeds")
        wan = _wan.WanKeyframeModel(wan_config, comfy.ops.pick_operations(torch.bfloat16, dtype, load_device=device))
        if dtype != torch.bfloat16:
            wan.manual_cast_dtype = dtype
        wan.load_state_dict(wan_sd, strict=True, assign=True)

        flash_sd, flash_config = _read_checkpoint(flash_model, "refvsr-flash-v1")
        flash_sd = {key: value.to(dtype) for key, value in flash_sd.items()}
        flash = _flash.FlashDecoder(flash_config, comfy.ops.disable_weight_init)
        flash.load_state_dict(flash_sd, strict=True, assign=True)

        return (RelayVSRModel(
            _patcher(wan, wan_sd, device, offload_device),
            _patcher(flash, flash_sd, device, offload_device),
            prompt_embeds,
            dtype,
        ),)


class AcademiaRelayVSRUpscale:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "relayvsr_model": ("RELAYVSR_MODEL",),
                "images": ("IMAGE",),
                "window_size": ("INT", {"default": 16, "min": 2, "max": 64, "tooltip": "Wan creates a reference every window_size-1 frames. Lower is slower and steadier, higher is faster."}),
                "output_scale": ("FLOAT", {"default": 4.0, "min": 1.0, "max": 4.0, "step": 0.25, "tooltip": "The model always works at x4; lower values downscale each frame and save a lot of RAM."}),
                "seed": ("INT", {"default": 42, "min": 0, "max": 0xffffffffffffffff}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "upscale"
    CATEGORY = "Academia SD/RelayVSR"

    def upscale(self, relayvsr_model, images, window_size, output_scale, seed):
        frames, height, width = images.shape[:3]
        output_size = (round(height * output_scale), round(width * output_scale))
        indices = _keyframe_indices(frames, window_size)
        logging.info(f"[RelayVSR] {frames} frames {width}x{height} -> {output_size[1]}x{output_size[0]}, {len(indices)} Wan references")
        progress = ProgressBar(len(indices) + frames)
        latents = _sample_keyframes(relayvsr_model, (images[index] for index in indices), height, width, seed, progress)
        comfy.model_management.soft_empty_cache()
        return (_decode_images(relayvsr_model, images, indices, latents, output_size, progress),)


class AcademiaRelayVSRVideoFile:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "relayvsr_model": ("RELAYVSR_MODEL",),
                "video": (_video_files(), {"tooltip": "Video in the input folder. Ignored when video_input is connected."}),
                "input_height": ("INT", {"default": 360, "min": 0, "max": 2160, "step": 2, "tooltip": "Resizes the source before upscaling. 0 keeps its size. The model works best on small sources: 360 gives 1440p, and 720 would give 5K and be far slower."}),
                "window_size": ("INT", {"default": 16, "min": 2, "max": 64, "tooltip": "Wan creates a reference every window_size-1 frames. Lower is slower and steadier, higher is faster."}),
                "output_scale": ("FLOAT", {"default": 4.0, "min": 1.0, "max": 4.0, "step": 0.25, "tooltip": "The model always works at x4; lower values downscale each frame."}),
                "segment_seconds": ("INT", {"default": 60, "min": 5, "max": 3600, "tooltip": "A part is saved every this many seconds. If the run stops, queueing it again with the same settings continues from the last finished part."}),
                "crf": ("INT", {"default": 16, "min": 0, "max": 51, "tooltip": "H.264 quality. Lower is better and larger."}),
                "seed": ("INT", {"default": 42, "min": 0, "max": 0xffffffffffffffff}),
                "filename_prefix": ("STRING", {"default": "RelayVSR/video"}),
            },
            "optional": {
                "video_input": ("VIDEO", {"tooltip": "Video from another node, such as Load Video or Create Video for IMAGE frames. Replaces the file above."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING", "VIDEO")
    RETURN_NAMES = ("video_path", "video")
    FUNCTION = "upscale"
    OUTPUT_NODE = True
    CATEGORY = "Academia SD/RelayVSR"
    DESCRIPTION = "Upscales a whole video file from disk to disk in resumable parts, keeps its audio, and joins everything in one MP4."

    @classmethod
    def VALIDATE_INPUTS(s, video, input_types):
        return _validate_video(video, input_types)

    def upscale(self, relayvsr_model, video, input_height, window_size, output_scale, segment_seconds, crf, seed, filename_prefix, unique_id, video_input=None):
        source = _source_path(video, video_input)
        _, source_h, source_w, _ = _probe_video(source)
        height, width = _input_size(source_h, source_w, input_height)
        output_size = _even_size(height, width, output_scale)
        dtype = relayvsr_model.dtype

        def sample(keyframes, done, progress):
            yield _sample_keyframes(relayvsr_model, keyframes, height, width, seed, progress)

        def decode(indices, latents, first_slot, read_window):
            flash, stream = _load_flash(relayvsr_model, height, width)
            device = relayvsr_model.flash.load_device
            for start, end, conditions in _windows(flash, stream, indices, [latent.to(device) for latent in latents], first_slot):
                yield from _decode_window(flash, stream, read_window(start, end), conditions, start > 0, output_size, dtype)

        settings = ("port", output_size, seed)
        return _upscale_file(source, settings, (height, width), window_size, segment_seconds, crf, filename_prefix, unique_id, sample, decode)


class AcademiaRelayVSRNativeVideo:
    """Long Video sobre el RelayVSR nativo de ComfyUI: mismos modelos que el flujo
    RelayVSR Conditioning, KSampler y VSR Decode, pero leyendo y escribiendo en disco.
    / Long Video on ComfyUI's native RelayVSR models."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "RelayVSR model from Load Diffusion Model."}),
                "vae": ("VAE", {"tooltip": "RelayVSR Flash decoder of the same factor, from Load VAE."}),
                "video": (_video_files(), {"tooltip": "Video in the input folder. Ignored when video_input is connected."}),
                "input_height": ("INT", {"default": 360, "min": 0, "max": 2160, "step": 2, "tooltip": "Resizes the source before upscaling. 0 keeps its size. The model works best on small sources: at x4, 360 gives 1440p, and 720 would give 5K and be far slower."}),
                "window_size": ("INT", {"default": NATIVE_MAX_WINDOW, "min": 2, "max": NATIVE_MAX_WINDOW, "tooltip": "Wan creates a reference every window_size-1 frames. 16 is the native value, the fastest; lower is slower and steadier."}),
                "output_scale": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 4.0, "step": 0.25, "tooltip": "0 keeps the factor of the model, x4 or x2. Other values resize each frame."}),
                "detail": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "How much of the detail added by the decoder is kept. 1 is the full model output."}),
                "segment_seconds": ("INT", {"default": 60, "min": 5, "max": 3600, "tooltip": "A part is saved every this many seconds. If the run stops, queueing it again with the same settings continues from the last finished part."}),
                "crf": ("INT", {"default": 16, "min": 0, "max": 51, "tooltip": "H.264 quality. Lower is better and larger."}),
                "seed": ("INT", {"default": 42, "min": 0, "max": 0xffffffffffffffff}),
                "filename_prefix": ("STRING", {"default": "RelayVSR/video"}),
            },
            "optional": {
                "video_input": ("VIDEO", {"tooltip": "Video from another node, such as Load Video or Create Video for IMAGE frames. Replaces the file above."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING", "VIDEO")
    RETURN_NAMES = ("video_path", "video")
    FUNCTION = "upscale"
    OUTPUT_NODE = True
    CATEGORY = "Academia SD/RelayVSR"
    DESCRIPTION = "Long Video with ComfyUI's native RelayVSR models: disk to disk, resumable, with the original audio."

    @classmethod
    def VALIDATE_INPUTS(s, video, input_types):
        return _validate_video(video, input_types)

    def upscale(self, model, vae, video, input_height, window_size, output_scale, detail, segment_seconds, crf, seed, filename_prefix, unique_id, video_input=None):
        diffusion_model = model.model.diffusion_model
        if not hasattr(diffusion_model, "positive_conditioning"):
            raise ValueError("Connect a RelayVSR model. It needs a ComfyUI version with native RelayVSR support.")
        source = _source_path(video, video_input)
        _, source_h, source_w, _ = _probe_video(source)
        height, width = _input_size(source_h, source_w, input_height)
        factor = vae.first_stage_model.upscale_factor
        output_size = _even_size(height, width, output_scale or factor)
        patch = diffusion_model.latent_stride * 2
        latent_size = (-(-height // patch) * 2, -(-width // patch) * 2)

        def sample(keyframes, done, progress):
            tokens = latent_size[0] * latent_size[1] // 4
            batch_size = max(WAN_CONTEXT + 2, WAN_PASS_TOKENS // tokens) - WAN_CONTEXT
            prompt = diffusion_model.positive_conditioning.unsqueeze(0).clone()
            keyframes = iter(keyframes)
            context = list(islice(keyframes, done))[-WAN_CONTEXT:]
            batch = done // batch_size
            while new := list(islice(keyframes, batch_size)):
                images = torch.stack(context + new)
                positive = [[prompt, {"lq_images": images}]]
                negative = [[prompt, {"lq_images": images}]]
                empty = torch.zeros([1, model.model.latent_format.latent_channels, len(images), *latent_size], device=comfy.model_management.intermediate_device())
                batch_seed = (seed + batch) % 2**64
                samples = nodes.common_ksampler(model, batch_seed, 1, 1.0, "euler", "simple", positive, negative, {"samples": empty})[0]["samples"]
                yield [latent.clone() for latent in samples.unbind(2)[len(context):]]
                progress.update(len(new))
                context = (context + new)[-WAN_CONTEXT:]
                batch += 1

        def decode(indices, latents, first_slot, read_window):
            for slot in range(first_slot, max(len(indices), 2)):
                first, last = slot - 1, min(slot, len(indices) - 1)
                window = torch.stack(read_window(indices[first], indices[last]))
                decoded = vae.decode(torch.stack(latents[first : last + 1], dim=2), vae_options={"lq_images": window, "detail": detail})
                decoded = decoded.reshape(-1, *decoded.shape[-3:])
                for image in decoded[1:] if indices[first] else decoded:
                    yield _resize_output(image.cpu(), output_size)

        settings = ("native", factor, output_size, detail, seed)
        return _upscale_file(source, settings, (height, width), window_size, segment_seconds, crf, filename_prefix, unique_id, sample, decode)


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_RelayVSRLoader": AcademiaRelayVSRLoader,
    "AcademiaSD_RelayVSRUpscale": AcademiaRelayVSRUpscale,
    "AcademiaSD_RelayVSRVideoFile": AcademiaRelayVSRVideoFile,
    "AcademiaSD_RelayVSRNativeVideo": AcademiaRelayVSRNativeVideo,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_RelayVSRLoader": "Academia SD RelayVSR Loader 🎞️",
    "AcademiaSD_RelayVSRUpscale": "Academia SD RelayVSR Upscale x4 🎞️",
    "AcademiaSD_RelayVSRVideoFile": "Academia SD RelayVSR Long Video 🎞️",
    "AcademiaSD_RelayVSRNativeVideo": "Academia SD RelayVSR Long Video (Native) 🎞️",
}
