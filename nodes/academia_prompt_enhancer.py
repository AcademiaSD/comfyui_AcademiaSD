import os
import re
import json
from math import gcd

# Las instrucciones del modelo viven en .md junto al paquete, no en el codigo:
# se retocan sin tocar Python, y otro modelo u otro estilo es otro fichero.
TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "enhancer_templates")

# Las proporciones que conoce la plantilla. Un width/height que caiga cerca de
# una de ellas se le dice con su nombre de siempre; 1448x1086 es "4:3", no
# "724:543".
KNOWN_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21",
                "2:1", "1:2", "4:5", "5:4", "3:1", "1:3"]

VISION_BLOCK = "<|vision_start|><|image_pad|><|vision_end|>"


def _templates():
    try:
        return sorted(f for f in os.listdir(TEMPLATES_DIR) if f.endswith(".md"))
    except OSError:
        return []


def _ratio(width, height):
    if not width or not height:
        return ""
    target = width / height
    best = min(KNOWN_RATIOS, key=lambda r: abs(int(r.split(":")[0]) / int(r.split(":")[1]) - target))
    w, h = (int(x) for x in best.split(":"))
    if abs(w / h - target) / target <= 0.03:
        return best
    d = gcd(width, height)
    return "{}:{}".format(width // d, height // d)


def _user_message(prompt, negative, has_image, ratio):
    parts = []
    if prompt:
        parts.append("Request (every part of it must survive):\n" + prompt)
    if has_image:
        parts.append("The image above is the starting point. Describe it as it looks once the request "
                     "is applied; the request wins wherever the two disagree."
                     if prompt else
                     "There is no written request: the image above is the whole brief.")
    if negative:
        parts.append("Keep out of the image:\n" + negative)
    if ratio:
        parts.append("Aspect ratio: " + ratio)
    return "\n\n".join(parts)


def _parse(text):
    """(orden de edicion, descripcion, ratio) de la respuesta. Si el modelo no
    devuelve un JSON limpio, el texto entero es la descripcion: mejor eso que
    parar el workflow."""
    text = re.sub(r"<think>.*?(?:</think>|$)", "", text, flags=re.DOTALL).strip()
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start:end + 1])
            if isinstance(data, dict) and isinstance(data.get("rewritten_prompt"), str):
                return (str(data.get("edit_instruction") or "").strip(), data["rewritten_prompt"].strip(),
                        str(data.get("wh_ratio") or "").strip())
        except ValueError:
            pass
    # Cortado por max_length a mitad del JSON: vale la descripcion que haya.
    cut = re.search(r'"rewritten_prompt"\s*:\s*"(.*)', text, flags=re.DOTALL)
    if cut:
        # Hasta la primera comilla sin escapar, que es donde acaba la cadena.
        body = re.match(r'(?:[^"\\]|\\.)*', cut.group(1), flags=re.DOTALL).group(0)
        try:
            return "", json.loads('"{}"'.format(body)).strip(), ""
        except ValueError:
            return "", body.replace('\\"', '"').strip(), ""
    return "", text, ""


def _compose(prompt, instruction, description):
    """La orden de edicion delante de la descripcion. Y si la peticion nombraba
    etiquetas <imageN> que no han llegado, va delante la peticion tal cual: el
    modelo puede resumir, pero lo que se pidio no se pierde."""
    out = "\n\n".join(p for p in (instruction, description) if p)
    missing = [t for t in dict.fromkeys(re.findall(r"<image\d+>", prompt)) if t not in out]
    if missing:
        out = "\n\n".join(p for p in (prompt, out) if p)
    return out


class AcademiaPromptEnhancer:
    @classmethod
    def INPUT_TYPES(s):
        templates = _templates()
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "A Qwen3-VL text encoder, like the one Qwen Image 2.1 loads. "
                                             "It sees the image and writes the prompt."}),
                "template": (templates, {"default": templates[0] if templates else ""}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 1.5, "step": 0.05,
                                          "tooltip": "0 sticks to what it receives and always writes the same "
                                                     "text. Higher values invent more of what the brief leaves open."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "max_length": ("INT", {"default": 1024, "min": 64, "max": 4096,
                                       "tooltip": "Tokens it may write. The template asks for about 500 words; "
                                                  "too few cuts the answer."}),
            },
            "optional": {
                "image": ("IMAGE",),
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "negative_prompt": ("STRING", {"multiline": True, "default": ""}),
                "width": ("INT", {"forceInput": True}),
                "height": ("INT", {"forceInput": True}),
            },
        }

    # No forma parte del workflow: sus salidas no se ensenan y nada cuelga de
    # ellas, asi que un Run normal no lo ejecuta nunca. El boton Enhance prompt
    # lo lanza aparte, con los nodos de los que depende y dos Preview as Text
    # que recogen estas dos salidas.
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "aspect_ratio")
    FUNCTION = "enhance"
    CATEGORY = "Academia SD"

    @classmethod
    def IS_CHANGED(s, template, **kwargs):
        # Retocar el .md tiene que notarse aunque en el nodo no cambie nada.
        if template not in _templates():
            return ""
        return os.path.getmtime(os.path.join(TEMPLATES_DIR, template))

    def enhance(self, clip, template, temperature, seed, max_length,
                image=None, prompt=None, negative_prompt=None, width=None, height=None):
        # El nombre llega del navegador: solo vale uno de los ficheros que hay.
        if template not in _templates():
            raise ValueError("Prompt Enhancer: template '{}' not found in enhancer_templates".format(template))
        prompt = (prompt or "").strip()
        negative_prompt = (negative_prompt or "").strip()
        if not prompt and image is None:
            raise ValueError("Prompt Enhancer needs a prompt, an image, or both")

        with open(os.path.join(TEMPLATES_DIR, template), "r", encoding="utf-8") as f:
            system = f.read().strip()
        ratio = _ratio(width, height)
        user = _user_message(prompt, negative_prompt, image is not None, ratio)

        # La conversacion entera a mano, en formato Qwen3: empezar por
        # <|im_start|> hace que el tokenizer no le ponga su propia plantilla. El
        # bloque <think> vacio apaga el razonamiento, que aqui solo gastaria tokens.
        text = ("<|im_start|>system\n{}<|im_end|>\n<|im_start|>user\n{}{}<|im_end|>\n"
                "<|im_start|>assistant\n<think>\n\n</think>\n\n").format(
                    system, VISION_BLOCK if image is not None else "", user)
        tokens = clip.tokenize(text, images=[image[:1]] if image is not None else [])

        ids = clip.generate(tokens, do_sample=temperature > 0, max_length=max_length,
                            temperature=max(temperature, 0.01), top_k=64, top_p=0.95, min_p=0.05,
                            repetition_penalty=1.05, seed=seed)
        instruction, description, model_ratio = _parse(clip.decode(ids))
        return (_compose(prompt, instruction, description), ratio or model_ratio)


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_PromptEnhancer": AcademiaPromptEnhancer,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_PromptEnhancer": "Academia SD Prompt Enhancer ✨",
}
