"""MOSS Layout: editor de cajas para el prompt de layout de MOSS-Image.

El editor (js/academia_moss_layout.js) guarda las cajas en `layout_data` en
coordenadas relativas 0..1, asi que no dependen de la resolucion. Al ejecutar se
pasan a pixeles con el width/height reales y se compila el JSON que entiende el
modelo, igual que compile_prompt.py de OpenMOSS (skills/moss-image-prompt-enhancer,
Apache-2.0): `summary`, `items` con la caja centrada en `yxyx`, `abs_centralized`.

The editor stores boxes in `layout_data` as 0..1 fractions, so they do not depend
on the resolution. At run time they become pixels for the real width/height and
the model-facing JSON is compiled as OpenMOSS's compile_prompt.py does.
"""

import json
import math
import os
import re

import comfy.utils
import folder_paths
import numpy as np
from aiohttp import web
from PIL import Image
from server import PromptServer

try:
    from .. import __version__ as ACADEMIASD_VERSION
except Exception:
    ACADEMIASD_VERSION = "2.6.1"

LABELS = ("object", "character", "text")
CANVAS = ("single", "multi_panel", "collage")
GENERICA = {"object": "An object", "character": "A character", "text": "Text"}

VISION_BLOCK = "<|vision_start|><|image_pad|><|vision_end|>"
# Una sola pasada (dos generaciones en la misma ejecucion rompen con un
# "device-side assert" de CUDA, ver el Prompt Enhancer). Cuadricula 0-1000, la
# nativa de Qwen3-VL para cajas.
ANALIZAR = (
    "Analyze this image to rebuild it as a layout. Output one JSON object and nothing else:\n"
    '{"caption": "...", "items": [{"label": "...", "bbox_2d": [x1, y1, x2, y2], "caption": "...", "text": "..."}]}\n'
    "caption: one paragraph describing the whole image: medium and style, setting, lighting, colors and composition.\n"
    "items: the elements worth placing, the largest and most important first, at most 20.\n"
    '- label "character": a person, animal or creature. "object": a distinct object or region (a product, a car, '
    'a building, a table, the sky). "text": a legible sign, title or text block.\n'
    "- bbox_2d: x from the left edge (0) to the right edge (1000), y from the top edge (0) to the bottom edge (1000); "
    "the box tightly encloses the element.\n"
    "- caption: what the element looks like, at most 25 words (appearance, color, material, pose; for text, its "
    "typography and color). No names of real people.\n"
    "- text: only for text items: every character exactly as written, in its own script, one item per text block "
    "with \\n between its lines. Omit the field for other labels.\n"
    "If there is no legible text, use no text items."
)


def _lista(v):
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [t.strip() for t in str(v or "").split(",") if t.strip()]


def _caja(box, width, height):
    """[x1,y1,x2,y2] en 0..1 -> [y1,x1,y2,x2] en pixeles desde el centro, con los
    bordes hacia fuera (floor/ceil) como el compilador oficial."""
    x1, y1, x2, y2 = (min(1.0, max(0.0, float(v))) for v in box)
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    px1, py1 = math.floor(x1 * width), math.floor(y1 * height)
    px2, py2 = max(px1 + 1, math.ceil(x2 * width)), max(py1 + 1, math.ceil(y2 * height))
    return [py1 - height // 2, px1 - width // 2, py2 - height // 2, px2 - width // 2]


def compilar(data, width, height):
    """El prompt de layout de MOSS-Image. Sin cajas validas, la descripcion global
    sola (un prompt normal). Las cajas sin descripcion, o de texto sin texto, se
    saltan con aviso en vez de parar el workflow."""
    s = data.get("summary") or {}
    summary = {"caption": str(s.get("caption") or "").strip()}
    if _lista(s.get("meta")):
        summary["meta"] = _lista(s.get("meta"))
    if s.get("canvas") in CANVAS:
        summary["canvas"] = s["canvas"]
    if _lista(s.get("palette")):
        summary["palette"] = _lista(s.get("palette"))

    items = []
    for i, it in enumerate(data.get("items") or []):
        label = it.get("label") if it.get("label") in LABELS else "object"
        # Sin descripcion la caja va igual, con una generica: su posicion ya dice algo.
        caption = str(it.get("caption") or "").strip() or GENERICA[label]
        text = str(it.get("text") or "")
        if label == "text" and not text.strip():
            print("[MOSS Layout v{}] text box #{} skipped: it has no text to render".format(
                ACADEMIASD_VERSION, i + 1))
            continue
        item = {"label": label, "caption": caption}
        if label == "text":
            item["text"] = text
        if _lista(it.get("tags")):
            item["tags"] = _lista(it.get("tags"))
        if _lista(it.get("palette")):
            item["palette"] = _lista(it.get("palette"))
        item["bbox"] = _caja(it.get("box") or [0.25, 0.25, 0.75, 0.75], width, height)
        items.append(item)

    if not items:
        return summary["caption"]
    out = {"summary": summary, "items": items, "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
    return json.dumps(out, ensure_ascii=False, separators=(",", ":"))


def _vista_fondo(image):
    """Copia pequena del fondo en temp, para que el editor la ensene."""
    arr = (image[0].cpu().numpy().clip(0, 1) * 255).astype(np.uint8)
    img = Image.fromarray(arr)
    img.thumbnail((1024, 1024))
    name = "moss_layout_bg_{}.png".format(os.getpid())
    img.save(os.path.join(folder_paths.get_temp_directory(), name))
    return [{"filename": name, "subfolder": "", "type": "temp"}]


class AcademiaMossLayout:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "width": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 16}),
                "height": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 16}),
                "negative_prompt": ("STRING", {"multiline": True, "default": "",
                                               "tooltip": "Plain negative prompt (no boxes). "
                                                          "MOSS-Image works fine with it empty."}),
                # Estado del editor (lo escribe el JS): cajas, descripcion global,
                # auto send y el JSON del panel.
                "layout_data": ("STRING", {"default": "{}", "multiline": False}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "Background reference shown behind the boxes. "
                                               "Only for placing them: it does not reach the model."}),
                "vlm": ("CLIP", {"tooltip": "Optional Qwen3-VL text encoder (as in the Prompt Enhancer) for the "
                                            "Analyze Image button, which places boxes from the image."}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "STRING")
    RETURN_NAMES = ("positive", "negative", "prompt")
    FUNCTION = "run"
    CATEGORY = "Academia SD/MOSS-Image"

    def run(self, clip, width, height, negative_prompt, layout_data, image=None, vlm=None):
        try:
            data = json.loads(layout_data or "{}")
        except ValueError:
            data = {}
        # Auto send: el JSON sale de las cajas en cada ejecucion. Sin el, manda el
        # panel tal cual (por si se ha retocado a mano).
        manual = str(data.get("json") or "").strip()
        prompt = compilar(data, width, height) if data.get("auto", True) or not manual else manual
        positive = clip.encode_from_tokens_scheduled(clip.tokenize(prompt))
        negative = clip.encode_from_tokens_scheduled(clip.tokenize(negative_prompt))
        ui = {"moss_layout": [{"width": width, "height": height, "json": prompt}]}
        if image is not None:
            ui["moss_layout_bg"] = _vista_fondo(image)
        return {"ui": ui, "result": (positive, negative, prompt)}


def _primer_json(text):
    """El primer objeto JSON de la respuesta; si llega cortado, se cierra quitando
    elementos del final hasta que sea valido."""
    text = re.sub(r"<think>.*?(?:</think>|$)", "", text, flags=re.DOTALL)
    i = text.find("{")
    if i < 0:
        return {}
    frag = text[i:]
    while True:
        try:
            return json.JSONDecoder().raw_decode(frag)[0]
        except ValueError:
            pass
        cerrado = _cerrar(frag)
        try:
            return json.loads(cerrado)
        except ValueError:
            k = max(frag.rfind("},"), frag.rfind("}]"))
            if k <= 0:
                return {}
            frag = frag[:k + 1]


def _cerrar(text):
    """Cierra la cadena, las listas y los objetos que hayan quedado abiertos."""
    pila, en_cadena, escape = [], False, False
    for ch in text:
        if en_cadena:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                en_cadena = False
        elif ch == '"':
            en_cadena = True
        elif ch in "{[":
            pila.append("}" if ch == "{" else "]")
        elif ch in "}]" and pila:
            pila.pop()
    text = re.sub(r"[,:\s]+$", "", text + ('"' if en_cadena else ""))
    return text + "".join(reversed(pila))


class AcademiaMossLayoutAnalyze:
    """Lo encola el boton Analyze Image de MOSS Layout: mira la imagen con un
    Qwen3-VL (cargado como CLIP, como en el Prompt Enhancer) y devuelve la escena
    y sus elementos con cajas en 0..1."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vlm": ("CLIP", {"tooltip": "A Qwen3-VL text encoder, e.g. the one you use in the Prompt Enhancer."}),
                "image": ("IMAGE",),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Lo lanza el boton: cada clic analiza, aunque la imagen no haya cambiado.
        return float("nan")

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("layout",)
    FUNCTION = "analyze"
    OUTPUT_NODE = True
    CATEGORY = "Academia SD/MOSS-Image"

    def analyze(self, vlm, image):
        img = image[:1]
        h, w = int(img.shape[1]), int(img.shape[2])
        k = min(1.0, (1024 * 1024 / float(h * w)) ** 0.5)
        if k < 1:
            img = comfy.utils.common_upscale(img.movedim(-1, 1), max(16, int(w * k)), max(16, int(h * k)),
                                             "area", "disabled").movedim(1, -1)
        text = ("<|im_start|>user\n{}{}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
                .format(VISION_BLOCK, ANALIZAR))
        tokens = vlm.tokenize(text, images=[img])
        # Greedy y sin repetition_penalty: la penalizacion castiga los digitos repetidos
        # de las coordenadas y desplaza las cajas.
        ids = vlm.generate(tokens, do_sample=False, max_length=2048)
        data = _primer_json(vlm.decode(ids))
        items = []
        for it in data.get("items") or []:
            b = it.get("bbox_2d") if isinstance(it, dict) else None
            if not (isinstance(b, list) and len(b) == 4 and all(isinstance(v, (int, float)) for v in b)):
                continue
            x1, y1, x2, y2 = (min(1.0, max(0.0, v / 1000.0)) for v in b)
            x1, x2 = sorted((x1, x2))
            y1, y2 = sorted((y1, y2))
            if x2 - x1 < 0.005 or y2 - y1 < 0.005:
                continue
            label = it.get("label") if it.get("label") in LABELS else "object"
            item = {"label": label, "caption": str(it.get("caption") or "").strip(), "box": [x1, y1, x2, y2]}
            if label == "text":
                item["text"] = str(it.get("text") or "")
            items.append(item)
        out = json.dumps({"caption": str(data.get("caption") or "").strip(), "items": items}, ensure_ascii=False)
        print("[MOSS Layout v{}] analyzed: {} boxes".format(ACADEMIASD_VERSION, len(items)))
        return {"ui": {"moss_layout_analysis": [out]}, "result": (out,)}


# Layouts guardados (Save/Load del editor) y current.json, el ultimo estado, que el
# editor va escribiendo para retomar las cajas otro dia.
LAYOUTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "moss_layouts")


def _layout_path(name):
    # El nombre llega por HTTP: nunca puede salir de LAYOUTS_DIR.
    name = "".join(c for c in str(name or "") if c.isalnum() or c in " -_").strip()
    return os.path.join(LAYOUTS_DIR, name + ".json") if name else None


@PromptServer.instance.routes.get("/academia/moss_layout/list")
async def moss_layout_list(request):
    names = sorted(f[:-5] for f in os.listdir(LAYOUTS_DIR) if f.endswith(".json")) if os.path.isdir(LAYOUTS_DIR) else []
    return web.json_response({"files": [n for n in names if n != "current"]})


@PromptServer.instance.routes.get("/academia/moss_layout/load")
async def moss_layout_load(request):
    path = _layout_path(request.query.get("name"))
    if not path or not os.path.isfile(path):
        return web.json_response({"error": "not found"}, status=404)
    with open(path, encoding="utf-8") as f:
        return web.json_response(json.load(f))


@PromptServer.instance.routes.post("/academia/moss_layout/save")
async def moss_layout_save(request):
    body = await request.json()
    path = _layout_path(body.get("name"))
    if not path or not isinstance(body.get("data"), dict):
        return web.json_response({"error": "invalid name or data"}, status=400)
    os.makedirs(LAYOUTS_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(body["data"], f, ensure_ascii=False, indent=2)
    return web.json_response({"name": os.path.basename(path)[:-5]})


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MossLayout": AcademiaMossLayout,
    "AcademiaSD_MossLayoutAnalyze": AcademiaMossLayoutAnalyze,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MossLayout": "AcademiaSD MOSS Layout 🗺️",
    "AcademiaSD_MossLayoutAnalyze": "AcademiaSD MOSS Layout Analyze",
}
