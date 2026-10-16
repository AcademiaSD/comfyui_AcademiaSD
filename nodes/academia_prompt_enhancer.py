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


def _read_template(name):
    # El nombre llega del navegador: solo vale uno de los ficheros que hay.
    if name not in _templates():
        raise ValueError("Prompt Enhancer: template '{}' not found in enhancer_templates".format(name))
    with open(os.path.join(TEMPLATES_DIR, name), "r", encoding="utf-8") as f:
        return f.read().strip()


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


def _is_flux3(template):
    return template.lower().startswith("flux3")


def _is_flux3_edit(template):
    return _is_flux3(template) and "edit" in template.lower()


def _flux3_message(prompt, negative, n_images, ratio, edit=False):
    """El upsampler de FLUX.3 esta entrenado con la peticion tal cual, precedida
    si acaso de la linea TARGET CANVAS: sin el envoltorio de las otras plantillas.
    El de edicion recibe solo la peticion: las imagenes ya van delante, en orden,
    y el tamano lo pone la primera referencia."""
    parts = ["TARGET CANVAS: " + ratio] if ratio and not edit else []
    if prompt:
        parts.append(prompt)
    if n_images and not edit:
        refs, role = (("the image above", "the reference") if n_images == 1 else
                      ("the images above, in order", "references"))
        parts.append("Use {} as {}; the request wins wherever they disagree.".format(refs, role)
                     if prompt else "Caption {}.".format(refs))
    if negative:
        parts.append("It must not contain: " + negative)
    return "\n".join(parts)


def _fit(image, max_pixels=1024 * 1024):
    """Una referencia a no mas de ~1 MP: el codificador de vision de Qwen3.5
    la procesaria entera, y diez fotos grandes son decenas de miles de tokens."""
    import comfy.utils
    h, w = int(image.shape[1]), int(image.shape[2])
    if h * w <= max_pixels:
        return image
    k = (max_pixels / float(h * w)) ** 0.5
    return comfy.utils.common_upscale(image.movedim(-1, 1), max(16, int(w * k)), max(16, int(h * k)),
                                      "area", "disabled").movedim(1, -1)


def _negative_message(prompt, negative, n_images, positive):
    parts = []
    if prompt:
        parts.append("Request:\n" + prompt)
    if n_images:
        parts.append("The image above is the reference." if n_images == 1 else
                     "The images above are the references, in order (the first image, the second image, ...).")
    parts.append("Positive prompt that will be rendered:\n" + positive)
    if negative:
        parts.append("Negative terms the user already wrote (they are kept, do not repeat them):\n" + negative)
    return "\n\n".join(parts)


def _strip_think(text):
    return re.sub(r"<think>.*?(?:</think>|$)", "", text, flags=re.DOTALL).strip()


def _hexes(colors, limit):
    out = []
    for c in colors if isinstance(colors, list) else []:
        m = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(c).strip())
        if m:
            out.append("#" + m.group(1).upper())
    return out[:limit]


def _bbox_caption(data):
    """Caption JSON con cajas (plantillas bbox json) en el formato de Ideogram 4, que
    usaran tambien Ideogram 4.5 y FLUX.3: orden de claves fijo, hex en mayusculas y
    cajas [y1, x1, y2, x2] en 0-1000. Qwen3-VL localiza en su formato nativo
    bbox_2d [x1, y1, x2, y2], asi que aqui se le da la vuelta."""
    sd_in = data.get("style_description") if isinstance(data.get("style_description"), dict) else {}
    sd = {"aesthetics": str(sd_in.get("aesthetics", "")), "lighting": str(sd_in.get("lighting", ""))}
    if str(sd_in.get("medium", "")).lower().startswith("photo"):
        sd["photo"] = str(sd_in.get("photo", ""))
        sd["medium"] = "photograph"
    else:
        sd["medium"] = str(sd_in.get("medium", ""))
        sd["art_style"] = str(sd_in.get("art_style", ""))
    palette = _hexes(sd_in.get("color_palette"), 16)
    if palette:
        sd["color_palette"] = palette

    cd = data["compositional_deconstruction"]
    elements, seen = [], set()
    for e in cd.get("elements") or []:
        if not isinstance(e, dict):
            continue
        el = {"type": "text" if e.get("type") == "text" else "obj"}
        box = e.get("bbox_2d")
        if isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box):
            x1, y1, x2, y2 = (max(0, min(1000, int(round(v)))) for v in box)
            el["bbox"] = [min(y1, y2), min(x1, x2), max(y1, y2), max(x1, x2)]
        if el["type"] == "text":
            el["text"] = str(e.get("text", ""))
        el["desc"] = str(e.get("desc", ""))
        # En escenas abarrotadas el modelo a veces entra en bucle y repite el mismo
        # elemento decenas de veces: misma caja o misma descripcion no se repiten.
        keys = {("desc", el.get("text", ""), el["desc"][:60].lower())}
        if "bbox" in el:
            keys.add(("box", el["type"], tuple(el["bbox"])))
        if keys & seen:
            continue
        seen |= keys
        palette = _hexes(e.get("color_palette"), 5)
        if palette:
            el["color_palette"] = palette
        elements.append(el)

    caption = {"high_level_description": str(data.get("high_level_description", "")), "style_description": sd,
               "compositional_deconstruction": {"background": str(cd.get("background", "")), "elements": elements}}
    return json.dumps(caption, ensure_ascii=False, separators=(",", ":"))


def _close_json(text):
    """Cierra la cadena, las listas y los objetos que hayan quedado abiertos."""
    stack, in_str, esc = [], False, False
    for ch in text:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]" and stack:
            stack.pop()
    text = re.sub(r"[,:\s]+$", "", text + ('"' if in_str else ""))
    return text + "".join(reversed(stack))


def _repair_tail(fragment):
    """Un objeto cortado: se cierra, quitando elementos del final hasta que sea valido."""
    while True:
        try:
            return json.loads(_close_json(fragment))
        except ValueError:
            k = max(fragment.rfind("},"), fragment.rfind("}]"))
            if k <= 0:
                return None
            fragment = fragment[:k + 1]


def _repair_caption(text):
    """Un caption JSON largo llega a veces partido en varios objetos seguidos, sin
    cerrar (cortado por max_length) o las dos cosas: se juntan los trozos y el
    ultimo se cierra, quitando el elemento que quedo a medias."""
    dec, merged, i = json.JSONDecoder(), {}, text.find("{")
    while i >= 0:
        try:
            obj, i = dec.raw_decode(text, i)
        except ValueError:
            obj, i = _repair_tail(text[i:]), -1
        if isinstance(obj, dict):
            merged.update(obj)
        if i >= 0:
            i = text.find("{", i)
    return merged if isinstance(merged.get("compositional_deconstruction"), dict) else None


def _parse(text):
    """(orden de edicion, descripcion, ratio) de la respuesta. Si el modelo no
    devuelve un JSON limpio, el texto entero es la descripcion: mejor eso que
    parar el workflow."""
    text = _strip_think(text)
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start:end + 1])
            if isinstance(data, dict) and isinstance(data.get("compositional_deconstruction"), dict):
                return "", _bbox_caption(data), str(data.get("aspect_ratio") or "").strip()
            if isinstance(data, dict) and isinstance(data.get("rewritten_prompt"), str):
                return (str(data.get("edit_instruction") or "").strip(), data["rewritten_prompt"].strip(),
                        str(data.get("wh_ratio") or "").strip())
        except ValueError:
            pass
    if '"compositional_deconstruction"' in text:
        data = _repair_caption(text)
        if data is not None:
            return "", _bbox_caption(data), str(data.get("aspect_ratio") or "").strip()
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


def _parse_negative(text):
    """Los terminos de la respuesta, venga en JSON o como lista suelta.

    El upsampler de FLUX.3 esta tan entrenado para describir que a veces
    ignora la plantilla del negativo: vuelve a escribir el caption del
    positivo y deja la lista al final, tras "Negative prompt:". Entonces vale
    solo lo que va detras. Y un trozo de mas de seis palabras no es un
    termino sino una frase del caption: fuera, o el negativo acaba siendo una
    copia del positivo y con CFG anula la guia."""
    text = _strip_think(text)
    start, end = text.find("{"), text.rfind("}")
    found = False
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start:end + 1])
            if isinstance(data, dict) and isinstance(data.get("negative_prompt"), str):
                text, found = data["negative_prompt"], True
        except ValueError:
            pass
    marks = [] if found else list(re.finditer(r'negative[ _]prompt"?\s*[:=]\s*', text, flags=re.IGNORECASE))
    if marks:
        text = text[marks[-1].end():]
        # Cortada por max_length a media lista: el ultimo trozo puede ser
        # media palabra ("shifted fra"). Si la lista no se cerro, fuera.
        if not re.search(r'"\s*\}?\s*$', text.split("\n")[0]):
            text = text.rsplit(",", 1)[0]
    terms, term_words, phrase_words = [], 0, 0
    for t in re.split(r"[,;\n]", text):
        t = re.sub(r"^(?:or|and)\s+", "", t.strip(" -*\"'.{}[]"), flags=re.IGNORECASE).strip(" -*\"'.")
        n = len(t.split())
        if not n:
            continue
        if n <= 6:
            terms.append(t)
            term_words += n
        else:
            phrase_words += n
    # La mayor parte del texto en frases: es un caption, no una lista, venga o
    # no dentro del JSON. Sus trozos cortos ("soft light") son cosas que el
    # positivo pide.
    if phrase_words >= term_words:
        return []
    return terms


def _compose(prompt, instruction, description):
    """La orden de edicion delante de la descripcion. Y si la peticion nombraba
    etiquetas <imageN> que no han llegado, va delante la peticion tal cual: el
    modelo puede resumir, pero lo que se pidio no se pierde."""
    out = "\n\n".join(p for p in (instruction, description) if p)
    missing = [t for t in dict.fromkeys(re.findall(r"<image\d+>", prompt)) if t not in out]
    if missing:
        out = "\n\n".join(p for p in (prompt, out) if p)
    return out


def _merge_negative(user, terms):
    """Lo que escribio el usuario, tal cual y delante; detras, los terminos
    nuevos que no estuvieran ya."""
    seen = user.lower()
    new = []
    for t in terms:
        if t.lower() not in seen and t.lower() not in (n.lower() for n in new):
            new.append(t)
    return ", ".join(p for p in (user.rstrip(" ,."), ", ".join(new)) if p)


class AcademiaPromptEnhancer:
    @classmethod
    def INPUT_TYPES(s):
        templates = _templates()
        is_neg = lambda t: "negative" in t or t.endswith("_neg.md")
        negatives = sorted((t for t in templates if is_neg(t)),
                           key=lambda t: t != "qwen_image_negative.md") or templates
        # La de Qwen-Image sigue siendo la de serie aunque otra vaya antes por orden alfabetico.
        positives = sorted((t for t in templates if not is_neg(t)),
                           key=lambda t: t != "qwen_image_rewriter.md") or templates
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "A Qwen3-VL text encoder, like the one Qwen Image 2.1 loads, or, "
                                             "for the Flux3Klein templates, the FLUX.3 prompt upsampler "
                                             "(qwen3.5_9b_flux3_prompt_upsampler). It sees the image and "
                                             "writes the prompt."}),
                "template": (templates, {"default": positives[0] if positives else ""}),
                "negative_template": (templates, {"default": negatives[0] if negatives else ""}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 1.5, "step": 0.05,
                                          "tooltip": "0 sticks to what it receives and always writes the same "
                                                     "text. Higher values invent more of what the brief leaves open."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "max_length": ("INT", {"default": 1024, "min": 64, "max": 4096,
                                       "tooltip": "Tokens it may write for the prompt. The template asks for "
                                                  "about 500 words; too few cuts the answer."}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "The first reference image."}),
                # Las referencias 2 a 10 solo las ven las plantillas Flux3Klein: el
                # upsampler de FLUX.3 mira todas las imagenes de la edicion, en orden.
                **{"image_{}".format(i): ("IMAGE", {"tooltip": "Reference image {}. Only the Flux3Klein "
                                                               "templates use it.".format(i)})
                   for i in range(2, 11)},
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "negative_prompt": ("STRING", {"multiline": True, "default": ""}),
                "width": ("INT", {"forceInput": True}),
                "height": ("INT", {"forceInput": True}),
                # Solo lo usa el boton, y no se ensena: con el positivo ya hecho,
                # esta ejecucion escribe el negativo.
                "positive": ("STRING", {"forceInput": True}),
            },
        }

    # No forma parte del workflow: sus salidas no se ensenan y nada cuelga de
    # ellas, asi que un Run normal no lo ejecuta nunca. El boton Enhance prompt
    # lo lanza aparte, con los nodos de los que depende y un Preview as Text por
    # cada una de estas salidas.
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "negative_prompt", "aspect_ratio")
    FUNCTION = "enhance"
    CATEGORY = "Academia SD"

    @classmethod
    def IS_CHANGED(s, template, negative_template, **kwargs):
        # Retocar un .md tiene que notarse aunque en el nodo no cambie nada.
        return [os.path.getmtime(os.path.join(TEMPLATES_DIR, n))
                for n in (template, negative_template) if n in _templates()]

    def enhance(self, clip, template, negative_template, temperature, seed, max_length,
                image=None, prompt=None, negative_prompt=None, width=None, height=None, positive=None,
                **more):
        prompt = (prompt or "").strip()
        negative_prompt = (negative_prompt or "").strip()
        if not prompt and image is None:
            raise ValueError("Prompt Enhancer needs a prompt, an image, or both")
        if _is_flux3_edit(template) and not prompt:
            raise ValueError("Prompt Enhancer: the Flux3 edit template needs a written request")

        # Las de Qwen-Image siguen viendo solo la primera, como siempre; las de
        # FLUX.3, todas las que lleguen, en orden y a ~1 MP.
        images = [image[:1]] if image is not None else []
        if _is_flux3(template):
            images += [more[k][:1] for k in ("image_{}".format(i) for i in range(2, 11))
                       if more.get(k) is not None]
            images = [_fit(im) for im in images]

        def generate(system, user, length, start=""):
            # La conversacion entera a mano, en formato Qwen3: empezar por
            # <|im_start|> hace que el tokenizer no le ponga su propia
            # plantilla. El bloque <think> vacio apaga el razonamiento, que aqui
            # solo gastaria tokens. `start` es el comienzo de la respuesta, ya
            # escrito: el modelo solo puede continuarlo.
            text = ("<|im_start|>system\n{}<|im_end|>\n<|im_start|>user\n{}{}<|im_end|>\n"
                    "<|im_start|>assistant\n<think>\n\n</think>\n\n{}").format(
                        system, VISION_BLOCK * len(images), user, start)
            tokens = clip.tokenize(text, images=images)
            ids = clip.generate(tokens, do_sample=temperature > 0, max_length=length,
                                temperature=max(temperature, 0.01), top_k=64, top_p=0.95, min_p=0.05,
                                repetition_penalty=1.05, seed=seed)
            return start + clip.decode(ids)

        # Una generacion por ejecucion, nunca dos. ComfyUI limpia entre nodo y
        # nodo lo que deja preparado una generacion en la GPU; una segunda en la
        # misma ejecucion lo reutilizaba ya invalido y rompia con un
        # "device-side assert" de CUDA. Por eso el negativo es otra ejecucion
        # de este mismo nodo, que recibe el positivo ya hecho.
        if positive is not None:
            # El upsampler de FLUX.3 esta entrenado para describir y, con la
            # plantilla del negativo, suele volver a escribir el caption. Con
            # la respuesta ya abierta como la lista JSON, solo le queda
            # continuar la lista.
            start = '{"negative_prompt": "' if _is_flux3(negative_template) else ""
            terms = _parse_negative(generate(_read_template(negative_template),
                                             _negative_message(prompt, negative_prompt, len(images), positive),
                                             256, start))
            return (positive, _merge_negative(negative_prompt, terms), "")

        ratio = _ratio(width, height)
        if _is_flux3(template):
            message = _flux3_message(prompt, negative_prompt, len(images), ratio, _is_flux3_edit(template))
        else:
            message = _user_message(prompt, negative_prompt, image is not None, ratio)
        instruction, description, model_ratio = _parse(generate(_read_template(template), message, max_length))
        if _is_flux3(template):
            # Texto llano: sin comillas alrededor aunque el modelo las ponga.
            description = description.strip().strip('"').strip()
        # Un caption JSON se devuelve tal cual: anteponerle texto lo dejaria invalido.
        if description.startswith('{"high_level_description"'):
            return (description, negative_prompt, ratio or model_ratio)
        return (_compose(prompt, instruction, description), negative_prompt, ratio or model_ratio)


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_PromptEnhancer": AcademiaPromptEnhancer,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_PromptEnhancer": "Academia SD Prompt Enhancer ✨",
}
