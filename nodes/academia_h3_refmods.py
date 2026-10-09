# -*- coding: utf-8 -*-
"""RefMods de MiniMax H3 con varios personajes sin que se mezclen.
/ MiniMax H3 RefMods for several characters without identity bleed.

POR QUE SE MEZCLAN
------------------
Un RefMod clasico se anade a la conditioning DESPUES del text encode: el DiT
atiende sus latentes, pero Qwen -- el text encoder -- nunca ve al sujeto. Con un
solo RefMod funciona, porque el modelo sabe que tiene que hacer "algo" con esa
referencia. Con dos o tres no hay nada que diga cual es cual: el prompt no
puede citar "<Video 1>" porque esa etiqueta no existe en la secuencia, y el
modelo promedia las caras, clona a uno de los dos o cambia las voces.

QUE HACEN ESTOS NODOS
---------------------
1. Presentan cada RefMod a Qwen con sus etiquetas nativas (<Video n>,
   <Picture n>, <Audio n>), en el MISMO orden que los bloques que recibe el DiT,
   exactamente como hace el nodo nativo "Reference to Video". Las fotos salen
   del JPEG guardado en el fichero (RefMods nuevos de LoRAlab) o, si no hay,
   decodificando los latentes con el VAE (RefMods antiguos: funcionan, pero la
   imagen que ve Qwen es peor).
2. Opcionalmente (bind_voice, experimental) atan la voz a la cara: la voz de un
   personaje y sus fotogramas viajan en un unico bloque "video_audio", que es
   como el modelo vio caras y voces juntas en su entrenamiento -- comparten
   origen temporal en el RoPE. Sin validar: ese bloque afirma que el fotograma
   n va con el instante n del audio, y un RefMod son fotos sueltas.
3. Escriben solos el bloque subject_definitions / retention_analysis con la
   numeracion correcta, y traducen @Nombre a "<Subject n> Nombre".

WHY THEY BLEED: classic RefMods are appended after text encoding, so Qwen never
sees the subjects and the prompt cannot reference them; several mods get
averaged, cloned or voice-swapped. These nodes present each mod to Qwen with
its native label in the same order as the DiT blocks, bind each voice to its
face in a native video_audio block, and write the subject block for you.
Older RefMods (latents only) still work: their frames are VAE-decoded for Qwen.
"""

import json
import math
import os
import re
import uuid
from collections import OrderedDict

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

import folder_paths
import node_helpers

# El mismo nombre de carpeta que registra ComfyUI-MiniMaxH3Mod, para que los dos
# packs vean los mismos ficheros. / Same folder as ComfyUI-MiniMaxH3Mod.
try:
    folder_paths.add_model_folder_path("refmods", os.path.join(folder_paths.models_dir, "refmods"))
except Exception:
    pass

META_KEYS = ("refmod_meta", "audio_refmod_meta")
NONE = "(none)"
AUTO = "(auto)"
CHARACTERS_TYPE = "ASD_H3_CHARACTERS"
STACK_MODES = ["up_to_n", "all", "every_4th_pairs"]
_SKIP_DIRS = {"graph_presets", ".git", "__pycache__"}


# ══════════════════════════════════════════════════════════════════════════
# Ficheros / Files
# ══════════════════════════════════════════════════════════════════════════

def _dirs():
    dirs = []
    try:
        dirs.extend(folder_paths.get_folder_paths("refmods"))
    except Exception:
        pass
    for sub in ("refmods", "mods", "audio_refmods"):
        d = os.path.join(folder_paths.models_dir, sub)
        if d not in dirs and os.path.isdir(d):
            dirs.append(d)
    return [d for d in dirs if os.path.isdir(d)]


def _read_meta(path):
    """Metadatos de la cabecera (o del .json lateral de versiones viejas)."""
    from safetensors import safe_open
    try:
        with safe_open(path, framework="pt") as f:
            meta = f.metadata() or {}
        for key in META_KEYS:
            if key in meta:
                return json.loads(meta[key])
    except Exception:
        pass
    side = path[:-len(".safetensors")] + ".json"
    if os.path.isfile(side):
        try:
            with open(side, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


_LIST_CACHE = {"key": None, "names": []}


def _list_refmods():
    """Nombres relativos de todos los RefMods validos. Se cachea por os.stat:
    ComfyUI llama a INPUT_TYPES en cada validacion."""
    found = []
    for d in _dirs():
        for root, subdirs, files in os.walk(d):
            subdirs[:] = sorted(s for s in subdirs if s not in _SKIP_DIRS)
            for fn in sorted(files):
                if fn.endswith(".safetensors"):
                    p = os.path.join(root, fn)
                    try:
                        st = os.stat(p)
                    except OSError:
                        continue
                    found.append((d, p, st.st_size, st.st_mtime_ns))
    key = tuple(found)
    if key == _LIST_CACHE["key"]:
        return _LIST_CACHE["names"]
    names = []
    for d, p, _, _ in found:
        meta = _read_meta(p)
        if isinstance(meta, dict) and meta.get("kind") in ("image", "video", "audio", "bundle"):
            name = os.path.relpath(p, d).replace("\\", "/")[:-len(".safetensors")]
            if name not in names:
                names.append(name)
    names.sort()
    _LIST_CACHE.update(key=key, names=names)
    return names


def _find(name):
    name = str(name or "").replace("\\", "/")
    if not name or name in (NONE, AUTO) or ".." in name.split("/"):
        return None
    for d in _dirs():
        p = os.path.join(d, name + ".safetensors")
        if os.path.isfile(p):
            return os.path.abspath(p)
    raise FileNotFoundError("RefMod '{}' not found in: {}".format(name, ", ".join(_dirs())))


def _stamp(path):
    try:
        st = os.stat(path)
        return "{}:{}:{}".format(path, st.st_size, st.st_mtime_ns)
    except (OSError, TypeError):
        return str(path)


class Ref:
    """Una referencia (visual o de audio) leida de un fichero o de un bundle."""

    def __init__(self, name, kind, latent, path="", index=-1, meta=None, frame_keys=None):
        self.name = name
        self.kind = kind              # image | video | audio
        self.latent = latent          # [1,24,T,H,W] o [1,32,2,T]
        self.path = path
        self.index = index
        self.meta = meta or {}
        self.frame_keys = list(frame_keys or [])

    @property
    def tokens(self):
        if self.kind == "audio":
            return 2 * int(self.latent.shape[-1])
        return int(self.latent.shape[2]) * (int(self.latent.shape[3]) // 2) * (int(self.latent.shape[4]) // 2)

    @property
    def layout(self):
        """'stills' (fotos sueltas apiladas) o 'video' (latente causal real).

        Importa al decodificar para Qwen: un apilado de fotos decodificado como
        video sale como basura, y un video real decodificado foto a foto tambien.
        Los RefMods nuevos lo dicen en los metadatos; para los viejos se deduce.
        """
        lay = self.meta.get("frame_layout")
        if lay in ("stills", "video"):
            return lay
        if str(self.meta.get("pool", "")).startswith("full-res"):
            return "stills"           # LoRAlab anteriores: siempre foto a foto
        if (self.kind == "video" and self.meta.get("source") == "video"
                and int(self.latent.shape[2]) % 5 == 2):
            return "video"
        return "stills"


def _valid(latent, kind):
    if kind == "audio":
        return latent.ndim == 4 and tuple(latent.shape[:3]) == (1, 32, 2) and latent.shape[-1] > 0
    return (latent.ndim == 5 and tuple(latent.shape[:2]) == (1, 24)
            and all(n > 0 for n in latent.shape[2:]) and latent.shape[3] % 2 == 0
            and latent.shape[4] % 2 == 0)


def _load_refs(path):
    """Todas las referencias de un fichero: una si es suelto, varias si es bundle."""
    from safetensors import safe_open
    meta = _read_meta(path)
    if not isinstance(meta, dict):
        raise ValueError("{} has no RefMod metadata.".format(path))
    stem = os.path.basename(path)[:-len(".safetensors")]
    refs = []
    with safe_open(path, framework="pt", device="cpu") as f:
        keys = set(f.keys())
        if meta.get("kind") == "bundle":
            members = meta.get("members") or []
            for i, m in enumerate(members):
                k = "ref_{}".format(i)
                if k not in keys or m.get("kind") not in ("image", "video", "audio"):
                    continue
                lat = f.get_tensor(k).clone()
                if not _valid(lat, m["kind"]):
                    raise ValueError("Invalid tensor layout in bundle member {} of {}".format(i, path))
                fk = _frame_keys(keys, "ref_{}_frame_".format(i), lat, m)
                refs.append(Ref(m.get("name") or "{}_{}".format(stem, i), m["kind"], lat,
                                path, i, m, fk))
        else:
            if "latent" not in keys:
                raise ValueError("{} has no 'latent' tensor.".format(path))
            lat = f.get_tensor("latent").clone()
            kind = meta.get("kind", "image")
            if not _valid(lat, kind):
                raise ValueError("Invalid RefMod tensor layout in {}".format(path))
            fk = _frame_keys(keys, "frame_", lat, meta)
            refs.append(Ref(meta.get("name") or stem, kind, lat, path, -1, meta, fk))
    return refs


def _frame_keys(keys, prefix, latent, meta):
    """Claves de las fotos JPEG guardadas, solo si casan 1:1 con los latentes."""
    if latent.ndim != 5:
        return []
    t = int(latent.shape[2])
    fk = [prefix + str(j) for j in range(t)]
    return fk if all(k in keys for k in fk) else []


_REF_CACHE = OrderedDict()


def _load_refs_cached(path):
    key = _stamp(path)
    if key in _REF_CACHE:
        _REF_CACHE.move_to_end(key)
        return _REF_CACHE[key]
    refs = _load_refs(path)
    _REF_CACHE[key] = refs
    while len(_REF_CACHE) > 24:
        _REF_CACHE.popitem(last=False)
    return refs


# ══════════════════════════════════════════════════════════════════════════
# Imagenes para Qwen / Images for Qwen
# ══════════════════════════════════════════════════════════════════════════

_IMG_CACHE = OrderedDict()


def _cache_put(key, value):
    _IMG_CACHE[key] = value
    while len(_IMG_CACHE) > 256:
        _IMG_CACHE.popitem(last=False)


def _jpeg_frame(ref, j):
    """Foto j guardada en el fichero -> [H, W, 3] float 0..1."""
    key = ("jpg", _stamp(ref.path), ref.index, j)
    if key in _IMG_CACHE:
        return _IMG_CACHE[key]
    from safetensors import safe_open
    import io
    with safe_open(ref.path, framework="pt", device="cpu") as f:
        raw = f.get_tensor(ref.frame_keys[j]).numpy().tobytes()
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    out = torch.from_numpy(np.asarray(img).astype(np.float32) / 255.0)
    _cache_put(key, out)
    return out


def _to_frames(px):
    """Salida de vae.decode -> [N, H, W, 3]."""
    if px.ndim == 5:
        px = px.reshape(-1, *px.shape[-3:])
    if px.ndim != 4 or px.shape[-1] != 3:
        raise ValueError("Unexpected VAE decode shape {}".format(tuple(px.shape)))
    return px.detach().float().cpu()


def _decoded_still(ref, j, vae):
    """Fotograma j de un apilado de fotos, decodificado SOLO ese fotograma."""
    key = ("dec", _stamp(ref.path), ref.index, j, ref.name)
    if key in _IMG_CACHE:
        return _IMG_CACHE[key]
    out = _to_frames(vae.decode(ref.latent[:, :, j:j + 1]))[-1]
    _cache_put(key, out)
    return out


def _decoded_video(ref, vae):
    key = ("vid", _stamp(ref.path), ref.index, ref.name)
    if key in _IMG_CACHE:
        return _IMG_CACHE[key]
    out = _to_frames(vae.decode(ref.latent))
    _cache_put(key, out)
    return out


def _need_vae(ref, vae):
    if vae is None:
        raise ValueError(
            "RefMod '{}' has no stored pictures (it was made with an older tool). "
            "Connect the MiniMax H3 video VAE so its frames can be decoded for the "
            "text encoder, or recreate it with LoRAlab Trainer Studio.\n"
            "El RefMod '{}' no lleva fotos guardadas: conecta el VAE de video de H3 "
            "o vuelve a crearlo con LoRAlab Trainer Studio.".format(ref.name, ref.name))


def _still(ref, j, vae):
    if ref.frame_keys:
        return _jpeg_frame(ref, j)
    _need_vae(ref, vae)
    return _decoded_still(ref, j, vae)


def _fit(frames, max_side):
    """Lista de [H,W,3] -> [K,H,W,3] con un tamano comun, lado largo <= max_side."""
    h, w = frames[0].shape[0], frames[0].shape[1]
    s = min(1.0, float(max_side) / float(max(h, w)))
    th = max(32, int(round(h * s / 32)) * 32)
    tw = max(32, int(round(w * s / 32)) * 32)
    out = []
    for fr in frames:
        x = fr.permute(2, 0, 1).unsqueeze(0)
        if x.shape[-2:] != (th, tw):
            x = F.interpolate(x, size=(th, tw), mode="bilinear", align_corners=False, antialias=True)
        out.append(x[0].permute(1, 2, 0))
    return torch.stack(out).clamp(0.0, 1.0)


def te_frames(ref, mode, n, vae, max_side):
    """(frames [K,H,W,3], timestamps) para presentar `ref` a Qwen como <Video>.

    Qwen agrupa los fotogramas de dos en dos en un mismo parche temporal. Dos
    fotos distintas en un parche se funden en una; por eso en "up_to_n" y "all"
    cada foto va DUPLICADA en su propio bloque, y Qwen la ve entera.
    "every_4th_pairs" reproduce el comportamiento antiguo (cada 4 fotos, por
    parejas): lo mas barato, suficiente con un solo RefMod.

    Qwen packs frames in pairs into one temporal patch; two different photos in
    a patch blend, so "up_to_n"/"all" duplicate each photo into its own block.
    """
    t = int(ref.latent.shape[2])
    if ref.layout == "video":
        _need_vae(ref, vae)
        px = _decoded_video(ref, vae)
        frames = [px[i] for i in range(0, px.shape[0], 12)]          # 24 fps -> 2 fps
        if mode == "up_to_n" and len(frames) > n:
            keep = torch.linspace(0, len(frames) - 1, n).round().long().tolist()
            frames = [frames[i] for i in sorted(set(keep))]
        frames = _fit(frames, max_side)
        return frames, [i / 2.0 for i in range(frames.shape[0])]

    if mode == "every_4th_pairs":
        idx = list(range(0, t, 4))        # el tokenizer rellena si quedan impares
        frames = _fit([_still(ref, j, vae) for j in idx], max_side)
        return frames, [i / 2.0 for i in range(frames.shape[0])]

    if mode == "up_to_n" and t > n:
        idx = sorted(set(torch.linspace(0, t - 1, n).round().long().tolist()))
    else:
        idx = list(range(t))
    frames = _fit([_still(ref, j, vae) for j in idx], max_side)
    frames = frames.repeat_interleave(2, dim=0)
    return frames, [i / 2.0 for i in range(frames.shape[0])]


def first_picture(ref, vae):
    """Primera foto del sujeto, o None si no hay forma de obtenerla."""
    if ref is None or ref.kind == "audio":
        return None
    if ref.frame_keys:
        return _jpeg_frame(ref, 0)
    if vae is None:
        return None
    if ref.layout == "video":
        return _decoded_video(ref, vae)[0]
    return _decoded_still(ref, 0, vae)


# ══════════════════════════════════════════════════════════════════════════
# Fuerza / Strength (mismo criterio que ComfyUI-MiniMaxH3Mod)
# ══════════════════════════════════════════════════════════════════════════

def _blur(z, factor=8):
    if z.dim() == 4:
        b, c, st, t = z.shape
        if t <= 1:
            return z
        flat = z.reshape(b * c * st, 1, t).float()
        down = F.adaptive_avg_pool1d(flat, max(1, t // factor))
        return F.interpolate(down, size=t, mode="linear", align_corners=False).reshape_as(z).to(z.dtype)
    t, h, w = z.shape[2], z.shape[3], z.shape[4]
    down = F.adaptive_avg_pool3d(z.float(), (t, max(1, h // factor), max(1, w // factor)))
    return F.interpolate(down, size=(t, h, w), mode="trilinear", align_corners=False).to(z.dtype)


def _weaken(z, strength):
    """Por debajo de 1 mezcla hacia una copia desenfocada: sigue siendo un
    latente plausible pero con menos detalle. Ni ceros ni ruido."""
    if strength >= 1.0:
        return z
    return strength * z + (1.0 - strength) * _blur(z)


# ══════════════════════════════════════════════════════════════════════════
# Nodo 1: personaje / Character
# ══════════════════════════════════════════════════════════════════════════

def _clean_name(name):
    name = os.path.basename(str(name or ""))
    for suf in ("_visual", "_audio"):
        if name.endswith(suf):
            name = name[:-len(suf)]
    return name


def _sibling_audio(visual_name):
    """'x_visual' -> 'x_audio', la pareja que escribe LoRAlab sin bundle."""
    if not visual_name.endswith("_visual"):
        return None
    try:
        p = _find(visual_name[:-len("_visual")] + "_audio")
    except FileNotFoundError:
        return None
    if not p:
        return None
    return next((r for r in _load_refs_cached(p) if r.kind == "audio"), None)


def _save_preview(img):
    """[H,W,3] -> fichero temporal para la vista previa del nodo."""
    arr = (img.detach().clamp(0, 1).numpy() * 255.0).round().astype(np.uint8)
    name = "asd_refmod_{}.png".format(uuid.uuid4().hex[:12])
    Image.fromarray(arr).save(os.path.join(folder_paths.get_temp_directory(), name), compress_level=1)
    return {"filename": name, "subfolder": "", "type": "temp"}


class AcademiaSD_H3RefModCharacter:
    """Un personaje: su RefMod visual, su voz y como diferenciarlo de los demas."""

    @classmethod
    def INPUT_TYPES(cls):
        mods = _list_refmods()
        return {
            "required": {
                "visual_refmod": ([NONE] + mods, {
                    "tooltip": "RefMod visual del personaje (o un bundle con visual + audio). "
                               "Sirven los antiguos y los de cualquier pack.\n"
                               "Visual RefMod of the character, or a bundle with visual + audio."}),
                "audio_refmod": ([AUTO, NONE] + mods, {
                    "tooltip": "(auto): el audio del bundle o el fichero hermano 'nombre_audio' que "
                               "escribe LoRAlab. / (auto): the bundle's audio or the sibling 'name_audio' file."}),
                "name": ("STRING", {"default": "", "tooltip":
                         "Nombre del personaje. Vacio = el del fichero. Usa @Nombre en el prompt.\n"
                         "Character name; empty = file name. Write @Name in the prompt."}),
                "appearance": ("STRING", {"default": "", "multiline": False, "tooltip":
                               "Lo que lo DIFERENCIA de los demas personajes (p.ej. 'oval face, red hair'). "
                               "Sin negaciones: H3 es destilado y las ignora.\n"
                               "What sets them apart from the others. No negatives."}),
                "voice_description": ("STRING", {"default": "", "tooltip":
                                      "Timbre de la voz, p.ej. 'low, husky, smooth'. / Voice timbre."}),
                "visual_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "audio_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "bind_voice": ("BOOLEAN", {"default": False, "tooltip":
                               "EXPERIMENTAL. Ata la voz a la cara en un bloque video_audio nativo (mismo origen "
                               "temporal) en vez de dejarla como referencia de audio suelta. Ojo: ese bloque dice "
                               "que el fotograma n va con el instante n del audio, y con fotos sueltas no es cierto. "
                               "Pruebalo con la misma semilla con y sin.\n"
                               "EXPERIMENTAL. One native video_audio block for voice + face. Compare same seed on/off."}),
                "show_preview": ("BOOLEAN", {"default": True, "tooltip":
                                 "Muestra la primera imagen codificada del sujeto. Los RefMods antiguos "
                                 "necesitan el VAE conectado.\nShow the subject's first encoded picture; "
                                 "older RefMods need the VAE."}),
                # Al final a proposito: los workflows guardados asignan los
                # widgets por orden. / Last on purpose: saved workflows map
                # widgets by position.
                "audio_max_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 120.0, "step": 0.5, "tooltip":
                                      "Recorta la voz a sus primeros N segundos (0 = entera). Iguala la duracion "
                                      "de las voces de todos los personajes: la mas larga tiende a imponerse y a "
                                      "colarse en los demas.\nTrim the voice to its first N seconds (0 = all). Keep "
                                      "every character's voice the same length."}),
            },
            "optional": {
                "characters": (CHARACTERS_TYPE, {"tooltip": "Encadena personajes anteriores. / Chain previous characters."}),
                "vae": ("VAE", {"tooltip": "VAE de video de H3, solo para la vista previa de RefMods antiguos."}),
            },
        }

    RETURN_TYPES = (CHARACTERS_TYPE, "IMAGE", "STRING")
    RETURN_NAMES = ("characters", "preview", "info")
    FUNCTION = "load"
    CATEGORY = "AcademiaSD/MiniMax H3"
    OUTPUT_NODE = False
    DESCRIPTION = ("Carga un personaje (RefMod visual + voz). Encadena varios y conectalos al "
                   "AcademiaSD H3 RefMod Encode. / Loads one character; chain several into the Encode node.")

    @classmethod
    def IS_CHANGED(cls, visual_refmod=NONE, audio_refmod=AUTO, **kwargs):
        out = []
        for n in (visual_refmod, audio_refmod):
            try:
                out.append(_stamp(_find(n)))
            except Exception:
                out.append(str(n))
        return "|".join(out)

    def load(self, visual_refmod, audio_refmod, name, appearance, voice_description,
             visual_strength, audio_strength, bind_voice, show_preview,
             audio_max_seconds=0.0, characters=None, vae=None):
        visual = audio = None
        notes = []
        vpath = _find(visual_refmod)
        if vpath:
            refs = _load_refs_cached(vpath)
            visual = next((r for r in refs if r.kind != "audio"), None)
            bundle_audio = next((r for r in refs if r.kind == "audio"), None)
        else:
            bundle_audio = None

        if audio_refmod == AUTO:
            audio = bundle_audio or (_sibling_audio(visual_refmod) if vpath else None)
            if audio is not None:
                notes.append("audio (auto): " + audio.name)
        elif audio_refmod != NONE:
            arefs = _load_refs_cached(_find(audio_refmod))
            audio = next((r for r in arefs if r.kind == "audio"), None)
            if audio is None:
                raise ValueError("'{}' has no audio reference.".format(audio_refmod))

        if visual is None and audio is None:
            raise ValueError("Select a visual or an audio RefMod. / Elige un RefMod visual o de audio.")

        if audio is not None and audio_max_seconds > 0:
            # Por el principio y sin remuestrear: un latente de audio remuestreado
            # no suena mas corto, suena mal. 40 latentes por segundo.
            # Contiguous prefix, never resampled: 40 latents per second.
            keep = max(1, int(round(audio_max_seconds * 40)))
            if keep < int(audio.latent.shape[-1]):
                audio = Ref(audio.name, "audio", audio.latent[..., :keep].clone(), audio.path,
                            audio.index, audio.meta)
                notes.append("audio trimmed to {:.1f} s".format(keep / 40.0))

        char = {
            "name": (name or "").strip() or _clean_name(visual_refmod if vpath else audio_refmod
                                                         if audio_refmod not in (AUTO, NONE) else "subject"),
            "appearance": (appearance or "").strip().rstrip("."),
            "voice": (voice_description or "").strip().rstrip("."),
            "visual": visual,
            "audio": audio,
            "visual_strength": float(visual_strength),
            "audio_strength": float(audio_strength),
            "bind_voice": bool(bind_voice),
        }
        chars = list(characters or []) + [char]

        if visual is not None:
            notes.insert(0, "visual: {} [{}] {} frames, {} tokens, {}".format(
                visual.name, visual.kind, int(visual.latent.shape[2]), visual.tokens,
                "fotos guardadas / stored pictures" if visual.frame_keys
                else "sin fotos: se decodifica con el VAE / no pictures: VAE decode"))
        if audio is not None:
            notes.append("audio: {:.1f} s, {} tokens".format(audio.latent.shape[-1] / 40.0, audio.tokens))
        info = "{} -> character #{}\n".format(char["name"], len(chars)) + "\n".join(notes)

        preview = torch.zeros(1, 64, 64, 3)
        ui = None
        if show_preview and visual is not None:
            pic = first_picture(visual, vae)
            if pic is None:
                info += "\npreview: conecta el VAE para ver RefMods antiguos / connect the VAE"
            else:
                preview = pic.unsqueeze(0)
                ui = {"images": [_save_preview(pic)]}
        print("[AcademiaSD H3 RefMod] " + info.replace("\n", " | "))
        if ui:
            return {"ui": ui, "result": (chars, preview, info)}
        return (chars, preview, info)


# ══════════════════════════════════════════════════════════════════════════
# Nodo 2: encode con etiquetas / Labeled encode
# ══════════════════════════════════════════════════════════════════════════

_NEGATION = re.compile(r"\b(no|not|don't|doesn't|isn't|aren't|without|never|none)\b", re.I)


def _from_h3mod(mods):
    """H3_REF_MODS de ComfyUI-MiniMaxH3Mod -> personajes, uno por referencia."""
    chars = []
    for mod, strength in mods or []:
        if strength <= 0:
            continue
        path = (mod.path + ".safetensors") if getattr(mod, "path", "") else ""
        ref = None
        if path and os.path.isfile(path):
            # Releer del fichero recupera las fotos guardadas y frame_layout,
            # que el objeto del otro pack no conserva.
            idx = getattr(mod, "bundle_index", -1)
            for r in _load_refs_cached(path):
                if (r.index == idx or idx < 0) and r.kind == mod.kind:
                    ref = r
                    break
        if ref is None:
            ref = Ref(mod.name, mod.kind, mod.latent, path, getattr(mod, "bundle_index", -1),
                      mod.metadata() if hasattr(mod, "metadata") else {})
        audio = ref.kind == "audio"
        chars.append({"name": _clean_name(mod.name), "appearance": "", "voice": "",
                      "visual": None if audio else ref, "audio": ref if audio else None,
                      "visual_strength": float(strength), "audio_strength": float(strength),
                      "bind_voice": False})
    return chars


def _subject_block(entries, prompt):
    """subject_definitions + retention_analysis en el formato que pide H3."""
    defs, ret = [], []
    for e in entries:
        s, name = e["subject"], e["name"]
        if e["vlabel"]:
            line = "{} is the person in {}".format(s, e["vlabel"])
            if e["appearance"]:
                line += ", " + e["appearance"]
            defs.append(line + ". Their name is {}.".format(name))
            ret.append("{}: fully_preserved - {}'s identity and appearance from {} are retained. "
                       "Face, facial features, body type.".format(s, s, e["vlabel"]))
        else:
            defs.append("{} is a person. Their name is {}.".format(s, name))
        if e["alabel"]:
            line = ("{} is the voice-timbre reference for {} ({}), guiding delivery and speaking rate "
                    "without copying the original signal.".format(e["alabel"], s, e["speaker"]))
            if e["voice"]:
                line += " It is {}.".format(e["voice"])
            defs.append(line)
            ret.append("{}: reference - its vocal timbre guides the dialogue delivery of {} without "
                       "copying the original signal.".format(e["alabel"], s))

    low = prompt.lower()
    out = prompt
    if "retention_analysis:" not in low and ret:
        block = "retention_analysis:\n" + "\n".join(ret) + "\n\n"
        i = low.find("detailed_description:")
        out = out[:i] + block + out[i:] if i >= 0 else block + out
    if "subject_definitions:" not in low and defs:
        out = "subject_definitions:\n" + "\n".join(defs) + "\n\n" + out
    return out


NATIVE_IMAGES, NATIVE_VIDEOS, NATIVE_AUDIOS = 9, 3, 3


def _native_refs(width, height, length, ref_image_size, kwargs, vae, audio_vae):
    """Las referencias del nodo oficial "MiniMax H3 Reference to Video", identicas.

    Mismo redimensionado, mismo orden y mismas funciones de ComfyUI que
    MiniMaxH3ReferenceToVideo.execute: imagenes, luego videos (la banda sonora
    de cada uno con su <Audio j> justo antes de su <Video k>) y, aparte, los
    audios sueltos. Se devuelven separados porque el Encode los coloca
    alrededor de los personajes: las imagenes y videos nativos van PRIMERO, asi
    los prompts de Ref2VA que ya citan "<Picture 1>" a mano siguen valiendo; los
    audios sueltos van al FINAL, para no quedar justo delante de la cara de un
    personaje y "regalarle" su voz.

    The official node's references, built exactly as it does. Native images and
    videos go first so existing "<Picture 1>" prompts keep working; standalone
    audios go last so they never sit right before a character's face.
    """
    from comfy_extras.nodes_minimax_h3 import (
        _resize, _encode_ref_audio, adapt_canvas, CANVAS_MULTIPLE, REF_IMAGE_SHORT_EDGE, FPS,
        temporal_shape)
    frame_count = temporal_shape(length)[0]
    head_items, head_blocks, tail_items, tail_blocks, names = [], [], [], [], []

    for i in range(NATIVE_IMAGES):
        img = kwargs.get("ref_image_%d" % i)
        if img is None:
            continue
        h, w = img.shape[1], img.shape[2]
        if ref_image_size == "match":
            scale = min(1.0, math.sqrt((width * height) / (w * h)))
        else:
            scale = min(1.0, REF_IMAGE_SHORT_EDGE / min(w, h))
        tw = max(CANVAS_MULTIPLE, round(w * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        th = max(CANVAS_MULTIPLE, round(h * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        resized = _resize(img[:1], tw, th, "disabled")
        head_items.append({"type": "image", "data": resized})
        names.append(("image", "ref_image_%d" % i))
        if vae is not None:
            z = vae.encode(resized)
            head_blocks.append({"kind": "image", "latent_h": th // 16, "latent_w": tw // 16, "latent": z})

    for i in range(NATIVE_VIDEOS):
        video_frames = kwargs.get("ref_video_%d" % i)
        if video_frames is None:
            continue
        soundtrack = kwargs.get("ref_video_audio_%d" % i)
        vh, vw = video_frames.shape[1], video_frames.shape[2]
        cw, ch = adapt_canvas(vw, vh)
        if vw * vh < cw * ch:
            cw = max(CANVAS_MULTIPLE, round(vw / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
            ch = max(CANVAS_MULTIPLE, round(vh / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        frames = _resize(video_frames, cw, ch, "disabled")
        if frames.shape[0] > frame_count:
            frames = frames[:frame_count]
        n = frames.shape[0]
        if n < 5:
            raise ValueError("MiniMax H3 reference videos need at least 5 frames (~0.2s at 24 fps)")
        while n % 17 != 5:
            n -= 1
        frames = frames[:n]
        if soundtrack is not None:
            head_items.append({"type": "audio"})
            names.append(("audio", "ref_video_audio_%d" % i))
        sample_idx = list(range(0, frames.shape[0], FPS // 2))
        head_items.append({"type": "video", "data": frames[sample_idx],
                           "timestamps": [k / 2.0 for k in range(len(sample_idx))]})
        names.append(("video", "ref_video_%d" % i))
        if vae is None:
            continue
        z = vae.encode(frames)
        audio_latent, ref_audio_t = (None, 0)
        if soundtrack is not None and audio_vae is not None:
            audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, soundtrack)
        head_blocks.append({"kind": "video_audio" if ref_audio_t else "video",
                            "latent_t": z.shape[2], "latent_h": ch // 16, "latent_w": cw // 16,
                            "ref_audio_t": ref_audio_t, "latent": z, "audio_latent": audio_latent})

    tail_names = []
    for i in range(NATIVE_AUDIOS):
        audio = kwargs.get("ref_audio_%d" % i)
        if audio is None:
            continue
        tail_items.append({"type": "audio"})
        tail_names.append(("audio", "ref_audio_%d" % i))
        if audio_vae is not None:
            audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, audio)
            tail_blocks.append({"kind": "audio", "ref_audio_t": ref_audio_t, "audio_latent": audio_latent})

    return head_items, head_blocks, names, tail_items, tail_blocks, tail_names


class AcademiaSD_H3RefModEncode:
    """Sustituye al nodo nativo "MiniMax H3 Reference to Video": mismas entradas
    nativas mas los personajes con RefMods. Sin personajes se comporta igual que
    el oficial. / Drop-in replacement for the official Reference to Video node."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "prompt": ("STRING", {"multiline": True, "dynamicPrompts": True, "tooltip":
                           "Escribe @Nombre para citar a un personaje. Sin negaciones.\n"
                           "Write @Name to cite a character. No negatives."}),
                "width": ("INT", {"default": 1344, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": 8192, "step": 32}),
                "length": ("INT", {"default": 124, "min": 5, "max": 3600, "step": 17}),
                "stack_pictures": (STACK_MODES, {"default": "up_to_n", "tooltip":
                                   "Cuantas fotos de cada RefMod ve el text encoder. Mas fotos = menos mezcla, "
                                   "mas lento.\nup_to_n: hasta N fotos, cada una en su bloque. all: todas. "
                                   "every_4th_pairs: cada 4, por parejas (lo mas ligero, comportamiento antiguo)."}),
                "stack_pictures_n": ("INT", {"default": 8, "min": 1, "max": 64}),
                "te_max_side": ("INT", {"default": 768, "min": 256, "max": 2048, "step": 32, "tooltip":
                                "Lado largo maximo de las fotos que ve Qwen. 768 es la resolucion nativa de H3."}),
                "auto_subject_block": ("BOOLEAN", {"default": True, "tooltip":
                                       "Escribe subject_definitions y retention_analysis si el prompt no los trae."}),
                # Al final a proposito: los workflows guardados asignan los
                # widgets por orden. / Last on purpose: widgets map by position.
                "ref_image_size": (["match", "max"], {"default": "match", "tooltip":
                                   "Como el nodo oficial: 'match' escala cada ref_image al area de la generacion; "
                                   "'max' usa lado corto 2048 (mas fiel, mas lento)."}),
            },
            "optional": dict(
                [("characters", (CHARACTERS_TYPE,)),
                 ("h3_mods", ("H3_REF_MODS", {"tooltip":
                              "Opcional: salida 'mods' de ComfyUI-MiniMaxH3Mod. Cada referencia se trata como "
                              "un sujeto sin nombre. / Optional mods from ComfyUI-MiniMaxH3Mod."})),
                 ("vae", ("VAE", {"tooltip": "VAE de video de H3: para ref_image/ref_video y para RefMods sin "
                                             "fotos guardadas."})),
                 ("audio_vae", ("VAE", {"tooltip": "VAE de audio de H3: solo para ref_audio y bandas sonoras "
                                                   "de ref_video. Los RefMods ya traen su audio codificado."})),
                 ("first_frame", ("IMAGE", {"tooltip": "FL2VA: primer fotograma, como en MiniMax H3 Image to Video "
                                                       "(<Picture 1> para Qwen + fotograma ancla)."})),
                 ("last_frame", ("IMAGE", {"tooltip": "FL2VA: ultimo fotograma, como en MiniMax H3 Image to Video."}))]
                + [("ref_image_%d" % i, ("IMAGE",)) for i in range(NATIVE_IMAGES)]
                + [("ref_video_%d" % i, ("IMAGE", {"tooltip": "Fotogramas a 24 fps (2-15 s)"}))
                   for i in range(NATIVE_VIDEOS)]
                + [("ref_video_audio_%d" % i, ("AUDIO", {"tooltip": "Banda sonora del ref_video con el mismo numero"}))
                   for i in range(NATIVE_VIDEOS)]
                + [("ref_audio_%d" % i, ("AUDIO",)) for i in range(NATIVE_AUDIOS)]),
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "STRING", "STRING")
    RETURN_NAMES = ("positive", "latent", "final_prompt", "reference_map")
    FUNCTION = "encode"
    CATEGORY = "AcademiaSD/MiniMax H3"
    DESCRIPTION = ("Encode de H3 con los RefMods etiquetados para el text encoder (<Video n>/<Audio n>) "
                   "y la voz atada a cada cara. Ya lleva las referencias: conecta directo al sampler, "
                   "sin RefMod Apply.")

    def encode(self, clip, prompt, width, height, length, stack_pictures, stack_pictures_n,
               te_max_side, auto_subject_block, ref_image_size="match", characters=None, h3_mods=None,
               vae=None, audio_vae=None, **kwargs):
        from comfy_extras.nodes_minimax_h3 import _empty_av_latent

        chars = list(characters or []) + _from_h3mod(h3_mods)
        items, blocks, entries, mapping = [], [], [], []
        count = {"image": 0, "video": 0, "audio": 0}
        total = 0

        def label(kind):
            count[kind] += 1
            return "<{} {}>".format({"image": "Picture", "video": "Video", "audio": "Audio"}[kind], count[kind])

        # FL2VA: primer/ultimo fotograma exactamente como MiniMaxH3ImageToVideo.
        # Qwen los ve como "<Picture 1>: ..." -- el mismo texto que produce su
        # tokenize(images=...) -- y el DiT los recibe como fotogramas ancla, no
        # como referencias. Van los primeros para conservar esa numeracion.
        # FL2VA first/last frames, exactly as the official node: <Picture n> for
        # Qwen plus keyframes for the DiT.
        keyframes = []
        first_frame, last_frame = kwargs.pop("first_frame", None), kwargs.pop("last_frame", None)
        if first_frame is not None or last_frame is not None:
            from comfy_extras.nodes_minimax_h3 import _resize, temporal_shape
            if vae is None:
                raise ValueError("first_frame/last_frame need the video VAE.")
            frame_count = temporal_shape(length)[0]
            for img, idx, crop, name in ((first_frame, 0, "disabled", "first_frame"),
                                         (last_frame, frame_count - 1, "center", "last_frame")):
                if img is None:
                    continue
                img = _resize(img[:1], width, height, crop)
                items.append({"type": "image", "data": img})
                keyframes.append({"resolved_frame_index": idx, "latent": vae.encode(img)})
                mapping.append("{} = {}".format(label("image"), name))

        # Referencias nativas de Ref2VA: imagenes y videos delante; los audios
        # sueltos se anaden al final, despues de los personajes.
        head_items, head_blocks, head_names, tail_items, tail_blocks, tail_names = _native_refs(
            width, height, length, ref_image_size, kwargs, vae, audio_vae)
        items.extend(head_items)
        blocks.extend(head_blocks)
        for kind, name in head_names:
            mapping.append("{} = {}".format(label(kind), name))
        if (head_names or tail_names) and vae is None and any(k != "audio" for k, _ in head_names):
            mapping.append("(!) ref_image/ref_video sin VAE: solo condicionan el texto, como en el nodo oficial.")

        for i, ch in enumerate(chars, 1):
            vis = ch["visual"] if ch["visual_strength"] > 0 else None
            aud = ch["audio"] if ch["audio_strength"] > 0 else None
            vlabel = alabel = None
            bound = vis is not None and aud is not None and ch["bind_voice"]
            alat = _weaken(aud.latent, ch["audio_strength"]) if aud is not None else None

            # LA VOZ VA ANTES DE SU CARA, NUNCA DESPUES.
            #
            # En el formato nativo, un video con banda sonora presenta el audio
            # justo antes que el video -- "<Audio j>: <Video k>: ..." en Qwen y
            # las filas de audio delante de las de video en el DiT -- y el modelo
            # aprendio que el audio que precede a un video es su voz. Poner la voz
            # DETRAS de su cara la deja justo delante de la cara del SIGUIENTE
            # personaje, y el modelo se la asigna a el: las voces salian cambiadas
            # siempre, en cualquier orden. Aqui la voz se emite primero, este o no
            # atada en un bloque video_audio.
            #
            # THE VOICE GOES BEFORE ITS FACE. Natively a soundtrack precedes its
            # video, so the model reads "audio right before a video" as that
            # video's voice. Placing it after its own face put it right before the
            # NEXT character's face, and voices came out swapped every time.
            if aud is not None:
                alabel = label("audio")
                items.append({"type": "audio"})
                if not bound:
                    blocks.append({"kind": "audio", "ref_audio_t": int(alat.shape[-1]),
                                   "audio_latent": alat, "refmod": True})
                total += aud.tokens

            if vis is not None:
                lat = _weaken(vis.latent, ch["visual_strength"])
                t, h, w = int(lat.shape[2]), int(lat.shape[3]), int(lat.shape[4])
                if t > 1 or bound:
                    frames, ts = te_frames(vis, stack_pictures, stack_pictures_n, vae, te_max_side)
                    vlabel = label("video")
                    items.append({"type": "video", "data": frames, "timestamps": ts})
                    blocks.append({"kind": "video_audio" if bound else "video",
                                   "latent_t": t, "latent_h": h, "latent_w": w,
                                   "ref_audio_t": int(alat.shape[-1]) if bound else 0,
                                   "latent": lat, "audio_latent": alat if bound else None,
                                   "refmod": True})
                else:
                    pic = _fit([_still(vis, 0, vae)], te_max_side)
                    vlabel = label("image")
                    items.append({"type": "image", "data": pic})
                    blocks.append({"kind": "image", "latent_h": h, "latent_w": w,
                                   "latent": lat, "refmod": True})
                total += vis.tokens

            if vlabel or alabel:
                entries.append({"subject": "<Subject {}>".format(i), "speaker": "S{}".format(i),
                                "name": ch["name"], "appearance": ch["appearance"], "voice": ch["voice"],
                                "vlabel": vlabel, "alabel": alabel})
                mapping.append("<Subject {}> {} = {}{}{}".format(
                    i, ch["name"], vlabel or "-", " + " + alabel if alabel else "",
                    " (voz atada / voice bound)" if bound else ""))

        items.extend(tail_items)
        blocks.extend(tail_blocks)
        for kind, name in tail_names:
            mapping.append("{} = {}".format(label(kind), name))

        warnings = []
        # ETIQUETAS ESCRITAS A MANO: la trampa que cambiaba las voces.
        #
        # "<Audio 1>" en el prompt significa "el primer audio de la lista", no
        # "la voz de Jon". Si alguien cambia el orden de los personajes, el
        # texto sigue diciendo que Jon habla con <Audio 1> -- que ahora es la voz
        # del otro -- y el modelo obedece: intercambia las voces porque el
        # prompt se lo pide. Los alias @Nombre.voice / @Nombre.video / @Nombre.S
        # se resuelven con el orden real y no pueden quedarse desfasados.
        #
        # HAND-WRITTEN LABELS: "<Audio 1>" means "first audio in the list", not
        # "Jon's voice". Reorder the characters and the prompt itself tells the
        # model to swap the voices. The @Name.voice / .video / .S aliases are
        # resolved from the actual order.
        raw = prompt or ""
        # Las referencias nativas (ref_image/ref_video/ref_audio) se citan a
        # mano con razon, como en el nodo oficial; solo se avisa si la etiqueta
        # escrita es de un PERSONAJE. / Native refs are legitimately cited by
        # hand; warn only about labels that belong to a character.
        char_labels = {e["vlabel"] for e in entries} | {e["alabel"] for e in entries}
        hand = set(re.findall(r"<(?:Audio|Video|Picture) \d+>", raw))
        if entries and (hand & char_labels or re.search(r"<Subject \d+>|\(S\d+\)", raw)):
            warnings.append("El prompt trae etiquetas escritas a mano (<Audio n>, <Video n>, <Subject n>, (Sn)). "
                            "Si cambias el orden de los personajes dejan de coincidir: usa @Nombre, "
                            "@Nombre.voice, @Nombre.video y @Nombre.S. / Hand-written labels found: use the "
                            "@Name aliases instead.")

        text = raw
        for e in sorted(entries, key=lambda e: -len(e["name"])):
            if not e["name"]:
                continue
            n = re.escape(e["name"])
            alias = {"voice": e["alabel"], "video": e["vlabel"], "s": e["speaker"]}
            def _sub(m, e=e, alias=alias):
                value = alias[m.group(1).lower()]
                if value is None:
                    warnings.append("@{}.{}: {} no tiene esa referencia / has no such reference.".format(
                        e["name"], m.group(1), e["name"]))
                    return m.group(0)
                return value
            text = re.sub(r"@" + n + r"\.(voice|video|S)\b", _sub, text, flags=re.I)
            text = re.sub(r"@" + n + r"\b",
                          lambda m, e=e: "{} {}".format(e["subject"], e["name"]), text, flags=re.I)

        # Contradicciones: una frase con un unico sujeto que cita la voz o el
        # identificador de otro. / A clause about one subject citing another's
        # voice or speaker id.
        owner = {e["subject"]: e for e in entries}
        for seg in re.split(r"(?<=[.!?])\s+|</d>", text):
            subs = set(re.findall(r"<Subject \d+>", seg))
            if len(subs) != 1:
                continue
            e = owner.get(subs.pop())
            if e is None:
                continue
            for a in re.findall(r"<Audio \d+>", seg):
                if e["alabel"] and a != e["alabel"]:
                    warnings.append("CONTRADICCION: {} ({}) habla con {}, pero su voz es {}. / {} speaks with "
                                    "{} but their voice is {}.".format(e["subject"], e["name"], a, e["alabel"],
                                                                      e["name"], a, e["alabel"]))
            for s in re.findall(r"\((S\d+)\)", seg):
                if s != e["speaker"]:
                    warnings.append("CONTRADICCION: {} ({}) aparece como ({}), deberia ser ({}).".format(
                        e["subject"], e["name"], s, e["speaker"]))
        if auto_subject_block and entries:
            text = _subject_block(entries, text)

        neg = sorted(set(m.group(0).lower() for m in _NEGATION.finditer(prompt or "")))
        if neg:
            print("[AcademiaSD H3 RefMod] aviso: el prompt tiene negaciones ({}); H3 es destilado y las "
                  "ignora. / warning: H3 ignores negatives.".format(", ".join(neg)))

        tokens = clip.tokenize(text, minimax_ref_items=items)
        cond = clip.encode_from_tokens_scheduled(tokens)
        if blocks:
            cond = node_helpers.conditioning_set_values(cond, {"minimax_refs": blocks})
        if keyframes:
            cond = node_helpers.conditioning_set_values(cond, {"minimax_keyframes": keyframes})
        latent, _ = _empty_av_latent(width, height, length)

        ref_map = "\n".join(mapping) or "No RefMods."
        ref_map += "\n{} reference tokens".format(total)
        for w in dict.fromkeys(warnings):
            ref_map += "\n(!) " + w
        print("[AcademiaSD H3 RefMod] " + ref_map.replace("\n", " | "))
        return (cond, latent, text, ref_map)


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_H3RefModCharacter": AcademiaSD_H3RefModCharacter,
    "AcademiaSD_H3RefModEncode": AcademiaSD_H3RefModEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_H3RefModCharacter": "AcademiaSD H3 RefMod Character",
    "AcademiaSD_H3RefModEncode": "AcademiaSD H3 RefMod Encode",
}
