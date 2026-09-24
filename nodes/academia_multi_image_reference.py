import os
import json
import shutil
import filecmp
import hashlib

import numpy as np
import torch
from PIL import Image, ImageOps
from aiohttp import web

import comfy.utils
import folder_paths
import node_helpers
from server import PromptServer

# Diez es lo que maneja Qwen Image 2.1, y encaja solo en el panel: una grande
# mas tres filas de tres. El numero manda sobre todo lo demas -- los nombres de
# las salidas se generan de aqui -- asi que subirlo o bajarlo es cambiarlo aqui
# y en SLOTS del .js.
#
# Ten is what Qwen Image 2.1 handles, and it falls out of the panel on its own:
# one large plus three rows of three. This number drives everything else -- the
# output names are generated from it.
SLOT_COUNT = 10

# Los mismos nombres que usa el Upscale Image de ComfyUI, porque por debajo es
# la misma llamada: comfy.utils.common_upscale.
SCALE_METHODS = ["lanczos", "bicubic", "bilinear", "area", "nearest-exact"]

# center   cubre el destino y recorta al centro         (common_upscale nativo)
# custom   igual, pero la ventana se coloca a mano        (aqui)
# pad      mete la imagen ENTERA y rellena el resto        (aqui)
# stretch  estira hasta el destino, deformando            (common_upscale nativo)
#
# center se deja intacto a proposito, delegando en ComfyUI: los workflows que ya
# lo usan tienen que seguir dando el pixel exacto de antes.
CROP_METHODS = ["center", "custom", "pad", "stretch"]

NAMED_COLORS = {
    "white": "ffffff", "black": "000000",
    "grey": "808080", "gray": "808080",
}


class AcademiaMultiImageReference:
    @classmethod
    def INPUT_TYPES(s):
        # Un unico STRING oculto con todo el estado, que es como guardan los
        # demas nodos de la casa: doce parejas de widgets fichero/interruptor
        # serian veinticuatro huecos en widgets_values, y anadir o quitar una
        # ranura mas adelante desplazaria los valores de los workflows ya
        # guardados. Con un JSON, la forma del widget no cambia nunca.
        return {
            "required": {
                "refs_data": ("STRING", {"default": ""}),
            },
            # El tamano es SOLO de la imagen 1: es la que fija el lienzo. Text
            # Encode Qwen Image 2.1 saca su latente de la primera referencia que
            # recibe, asi que es la unica cuyo tamano cambia el resultado; las
            # demas las reescala el propio encoder a su `resolution`.
            #
            # width y height en 0 significan "no tocar la imagen": asi el nodo
            # sigue sirviendo de cargador a secas si no se quiere reescalar.
            # Enlazando WIDTH y HEIGHT de Resolution Calc se quita de en medio
            # el nodo de reescalado y su Get Image Size.
            "optional": {
                "width": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 8}),
                "height": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 8}),
                "scale_method": (SCALE_METHODS, {"default": "lanczos"}),
                "crop": (CROP_METHODS, {"default": "pad"}),
                # Solo pinta en modo pad. Admite "#RRGGBB", "RRGGBB", "#RGB" o
                # los nombres white / black / grey.
                "pad_color": ("STRING", {"default": "#000000"}),
                # Con el interruptor apagado la imagen va centrada y entera, que
                # es el relleno de toda la vida. Encendido, manda la colocacion
                # que se haya arrastrado en el panel: eso es el outpaint.
                "outpaint": ("BOOLEAN", {"default": False,
                                         "label_on": "Outpaint ON",
                                         "label_off": "Outpaint OFF"}),
            },
        }

    # En pantalla este nodo no tiene salidas: se cablean en Multi Image
    # Reference Out, que al encolar redirige su salida N a la salida N de aqui.
    # Por eso el orden tiene que ser el mismo en los dos sitios.
    RETURN_TYPES = ("IMAGE",) * SLOT_COUNT + ("INT",)
    RETURN_NAMES = (tuple("image_{}".format(i) for i in range(1, SLOT_COUNT + 1))
                    + ("Reference_active",))
    FUNCTION = "load_references"
    CATEGORY = "Academia SD"

    # --- ESTADO ---

    @staticmethod
    def _slots(refs_data):
        """Siempre SLOT_COUNT ranuras {file, on}, venga lo que venga en el JSON.

        `file` es lo que sale por la ranura: su mapa de ControlNet si lo tiene
        encendido, y si no la imagen.
        """
        try:
            data = json.loads(refs_data) if refs_data else {}
        except Exception:
            data = {}
        raw = data.get("slots") if isinstance(data, dict) else None
        if not isinstance(raw, list):
            raw = []

        out = []
        for i in range(SLOT_COUNT):
            item = raw[i] if i < len(raw) and isinstance(raw[i], dict) else {}
            cn = item.get("cn") if isinstance(item.get("cn"), dict) else {}
            file = str(item.get("file") or "")
            if file and cn.get("on") and cn.get("map"):
                file = str(cn["map"])
            out.append({
                "file": file,
                "on": bool(item.get("on", False)),
            })
        return out

    @staticmethod
    def _is_active(slot):
        return bool(slot["on"] and slot["file"])

    @staticmethod
    def _placement(refs_data):
        """Centro y escala de la imagen 1 dentro del lienzo, en fracciones.

        Viajan en refs_data y no en widgets propios porque se ponen
        arrastrando el recuadro en el panel, no escribiendo numeros.
        x e y pueden salirse de 0..1 a proposito: en un outpaint es normal
        que parte de la imagen quede fuera del lienzo.
        """
        try:
            data = json.loads(refs_data) if refs_data else {}
        except Exception:
            data = {}
        raw = data.get("place") if isinstance(data, dict) else None
        if not isinstance(raw, dict):
            raw = {}

        def num(key, default, lo, hi):
            try:
                v = float(raw.get(key, default))
            except (TypeError, ValueError):
                return default
            if v != v or v in (float("inf"), float("-inf")):   # NaN e infinitos
                return default
            return min(hi, max(lo, v))

        return num("x", 0.5, -3.0, 4.0), num("y", 0.5, -3.0, 4.0), num("scale", 1.0, 0.02, 8.0)

    @staticmethod
    def _crop_pos(refs_data):
        """Centro de la ventana de recorte sobre la imagen, en fracciones.

        Solo pinta en modo custom. 0.5, 0.5 es exactamente el centro, o sea
        lo mismo que hace el modo center.
        """
        try:
            data = json.loads(refs_data) if refs_data else {}
        except Exception:
            data = {}
        raw = data.get("cropPos") if isinstance(data, dict) else None
        if not isinstance(raw, dict):
            raw = {}

        def num(key):
            try:
                v = float(raw.get(key, 0.5))
            except (TypeError, ValueError):
                return 0.5
            if v != v or v in (float("inf"), float("-inf")):
                return 0.5
            return min(1.0, max(0.0, v))

        return num("x"), num("y")

    @staticmethod
    def _parse_color(text):
        """"#RRGGBB", "RRGGBB", "#RGB" o un nombre. Lo que no se entienda, negro."""
        t = str(text or "").strip().lower().lstrip("#")
        t = NAMED_COLORS.get(t, t)
        if len(t) == 3:
            t = "".join(c * 2 for c in t)
        if len(t) != 6:
            return (0.0, 0.0, 0.0)
        try:
            return tuple(int(t[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
        except ValueError:
            return (0.0, 0.0, 0.0)

    # --- EJECUCION ---

    @staticmethod
    def _load_one(name):
        path = folder_paths.get_annotated_filepath(name)
        img = node_helpers.pillow(Image.open, path)
        img = node_helpers.pillow(ImageOps.exif_transpose, img)
        # RGB, no RGBA. Es lo que devuelve el LoadImage de ComfyUI, y una IMAGE
        # de cuatro canales rompe a la mitad de los nodos por los que pueda
        # pasar de camino. Qwen compone el alfa sobre blanco por su cuenta.
        arr = np.array(img.convert("RGB")).astype(np.float32) / 255.0
        return torch.from_numpy(arr)[None, ]

    @classmethod
    def _resize(cls, image, width, height, scale_method, crop,
                pad_color="#000000", outpaint=False, place=(0.5, 0.5, 1.0),
                crop_pos=(0.5, 0.5)):
        if image is None or width <= 0 or height <= 0:
            return image
        tw, th = int(width), int(height)

        # center y stretch son literalmente el Upscale Image nativo; alli stretch
        # se llama "disabled".
        if crop in ("center", "stretch"):
            samples = image.movedim(-1, 1)                  # NHWC -> NCHW
            return comfy.utils.common_upscale(samples, tw, th, scale_method,
                                              "center" if crop == "center" else "disabled").movedim(1, -1)

        # custom: la misma ventana que center -- la mayor que cubre el destino
        # sin deformar -- pero colocada donde se haya arrastrado en el panel.
        if crop == "custom":
            image = image[:1]
            oh, ow = int(image.shape[1]), int(image.shape[2])
            if ow <= 0 or oh <= 0:
                return image
            old_a, new_a = ow / float(oh), tw / float(th)
            kw, kh = ow, oh
            if old_a > new_a:
                kw = max(1, int(round(ow * (new_a / old_a))))
            elif old_a < new_a:
                kh = max(1, int(round(oh * (old_a / new_a))))
            cx, cy = crop_pos
            # La ventana no puede salirse de la imagen: lo de fuera no existe.
            x = min(ow - kw, max(0, int(round(cx * ow - kw / 2.0))))
            y = min(oh - kh, max(0, int(round(cy * oh - kh / 2.0))))
            window = image[:, y:y + kh, x:x + kw, :]
            samples = window.movedim(-1, 1)
            return comfy.utils.common_upscale(samples, tw, th, scale_method, "disabled").movedim(1, -1)

        # pad: la imagen entra entera y lo que sobra se rellena. Apagado el
        # outpaint es el relleno clasico, centrado y a tamano maximo.
        image = image[:1]
        oh, ow = int(image.shape[1]), int(image.shape[2])
        if ow <= 0 or oh <= 0:
            return image
        fit = min(tw / float(ow), th / float(oh))
        px, py, ps = place if outpaint else (0.5, 0.5, 1.0)

        dw = max(1, int(round(ow * fit * ps)))
        dh = max(1, int(round(oh * fit * ps)))
        x0 = int(round(px * tw - dw / 2.0))
        y0 = int(round(py * th - dh / 2.0))

        r, g, b = cls._parse_color(pad_color)
        canvas = torch.empty((1, th, tw, 3), dtype=image.dtype, device=image.device)
        canvas[..., 0], canvas[..., 1], canvas[..., 2] = r, g, b

        # Lo que caiga fuera del lienzo se pierde, que es justo lo que se ve en
        # el panel al arrastrar el recuadro hacia el borde.
        dx0, dy0 = max(0, x0), max(0, y0)
        dx1, dy1 = min(tw, x0 + dw), min(th, y0 + dh)
        if dx1 > dx0 and dy1 > dy0:
            placed = comfy.utils.common_upscale(
                image.movedim(-1, 1), dw, dh, scale_method, "disabled").movedim(1, -1)
            sx0, sy0 = dx0 - x0, dy0 - y0
            canvas[:, dy0:dy1, dx0:dx1, :] = placed[:, sy0:sy0 + (dy1 - dy0),
                                                    sx0:sx0 + (dx1 - dx0), :3]
        return canvas

    def load_references(self, refs_data="", width=0, height=0,
                        scale_method="lanczos", crop="pad",
                        pad_color="#000000", outpaint=False):
        # Una ranura apagada o vacia sale como None, que es exactamente lo que
        # Text Encode Qwen Image 2.1 descarta con su `if image is None: continue`.
        # No hace falta ningun bypass ni desconectar el cable: el apagado viaja
        # por el mismo hilo.
        out = []
        for i, slot in enumerate(self._slots(refs_data)):
            img = self._load_one(slot["file"]) if self._is_active(slot) else None
            if i == 0:
                img = self._resize(img, width, height, scale_method, crop,
                                   pad_color, outpaint, self._placement(refs_data),
                                   self._crop_pos(refs_data))
            out.append(img)

        # Las que de verdad llegan al encoder: encendida Y con fichero. Es el
        # mismo criterio que decide las etiquetas <imageN>, asi que este numero
        # es exactamente cuantas de esas hay.
        active = sum(1 for slot in self._slots(refs_data) if self._is_active(slot))
        return tuple(out) + (active,)

    # --- CACHE Y VALIDACION ---

    @classmethod
    def IS_CHANGED(s, refs_data="", width=0, height=0, scale_method="lanczos", crop="pad",
                   pad_color="#000000", outpaint=False):
        # refs_data ya entra en el hash del prompt, asi que lo unico que hay que
        # detectar aqui es que un FICHERO haya cambiado por fuera sin cambiar de
        # nombre: sobrescribir una referencia y volver a encolar tiene que
        # recargarla. Fecha y tamano en vez de leer los bytes, que son doce
        # imagenes en cada encolado.
        m = hashlib.sha256()
        for slot in s._slots(refs_data):
            if not s._is_active(slot):
                continue
            try:
                st = os.stat(folder_paths.get_annotated_filepath(slot["file"]))
                key = "{}|{}|{}".format(slot["file"], st.st_mtime_ns, st.st_size)
            except Exception:
                key = "{}|missing".format(slot["file"])
            m.update(key.encode("utf-8"))
        return m.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(s, refs_data="", width=0, height=0, scale_method="lanczos", crop="pad",
                        pad_color="#000000", outpaint=False):
        # Una referencia que falta NO puede pasar en silencio. Qwen numera las
        # <imageN> por la posicion en la lista ya compactada, asi que perder una
        # por el camino corre todas las de detras y el prompt acaba hablando de
        # otra imagen sin que nada lo diga.
        missing = [
            str(i + 1) for i, slot in enumerate(s._slots(refs_data))
            if s._is_active(slot) and not folder_paths.exists_annotated_filepath(slot["file"])
        ]
        if missing:
            return "Academia SD Multi Image Reference: file missing in slot(s) {}".format(", ".join(missing))
        return True


# --- PROYECTOS ---
#
# Un proyecto es input/<nombre>/: las referencias copiadas y <nombre>.json con
# su ranura, si van encendidas y el resto del estado del nodo. Vive en input/
# porque de ahi es de donde el nodo carga las imagenes.
#
# Solo cuenta como proyecto la carpeta que tiene ESE json con ESTE kind. input/
# es de todos -- clipspace, las subidas, carpetas del usuario -- y al otro lado
# de Delete hay un borrado recursivo: una carpeta que se llame igual pero no
# sea nuestra no se toca, ni para borrarla ni para escribir en ella.

PROJECT_KIND = "academia_multi_image_reference"


def _sanitize_project(name):
    """Misma lista blanca que Multi Prompt y Project Paths: letras, numeros,
    espacio, guion y guion bajo. Nada de barras, puntos ni dos puntos."""
    return "".join(c for c in str(name or "") if c.isalnum() or c in (" ", "-", "_")).strip()


def _input_dir():
    return os.path.abspath(folder_paths.get_input_directory())


def _project_dir(name):
    """(nombre limpio, input/<nombre>), o (nombre, None) si no vale."""
    safe = _sanitize_project(name)
    if not safe:
        return safe, None
    base = _input_dir()
    path = os.path.abspath(os.path.join(base, safe))
    if path == base or os.path.commonpath([base, path]) != base:
        return safe, None
    return safe, path


def _read_project(folder, safe):
    """El json del proyecto, o None si esa carpeta no es un proyecto nuestro."""
    try:
        with open(os.path.join(folder, safe + ".json"), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("kind") == PROJECT_KIND else None


def _copy_into(rel, folder, used):
    """Copia la referencia `rel` de input/ a la carpeta del proyecto y devuelve
    su nombre alli.

    Cada ranura acaba con SU fichero aunque dos tengan la misma imagen: una
    copia hecha con el boton de copiar tiene que poder cambiar sin arrastrar a
    la otra. La primera conserva el nombre y las demas llevan _02, _03... Un
    fichero que ya esta ahi con el mismo contenido se reutiliza, asi que volver
    a guardar no multiplica nada. `used` son los nombres ya dados en este Save.
    """
    base = _input_dir()
    src = os.path.abspath(folder_paths.get_annotated_filepath(rel))
    if os.path.commonpath([base, src]) != base or not os.path.isfile(src):
        raise FileNotFoundError(rel)
    stem, ext = os.path.splitext(os.path.basename(src))
    name, n = stem + ext, 2
    while name in used or (os.path.exists(os.path.join(folder, name))
                           and not filecmp.cmp(src, os.path.join(folder, name), shallow=False)):
        name = "{}_{:02d}{}".format(stem, n, ext)
        n += 1
    if not os.path.exists(os.path.join(folder, name)):
        shutil.copy2(src, os.path.join(folder, name))
    used.add(name)
    return name


def _error(message, status=400):
    return web.json_response({"status": "error", "message": message}, status=status)


@PromptServer.instance.routes.get("/academia/multiref/list")
async def multiref_list(request):
    base = _input_dir()
    names = [d for d in os.listdir(base)
             if os.path.isdir(os.path.join(base, d)) and _read_project(os.path.join(base, d), d)]
    return web.json_response({"status": "success", "projects": sorted(names, key=str.lower)})


@PromptServer.instance.routes.post("/academia/multiref/save")
async def multiref_save(request):
    body = await request.json()
    safe, folder = _project_dir(body.get("name"))
    if folder is None:
        return _error("Invalid project name")
    state = body.get("state")
    if not isinstance(state, dict) or not isinstance(state.get("slots"), list):
        return _error("Bad request")
    if os.path.isdir(folder) and _read_project(folder, safe) is None:
        return _error('input/{} already exists and is not a Multi Image Reference project'.format(safe))

    os.makedirs(folder, exist_ok=True)
    slots, used = [], set()
    for i, slot in enumerate(state["slots"][:SLOT_COUNT]):
        slot = slot if isinstance(slot, dict) else {}
        file = str(slot.get("file") or "")
        cn = dict(slot["cn"]) if isinstance(slot.get("cn"), dict) else None
        try:
            if file:
                file = _copy_into(file, folder, used)
            if file and cn and cn.get("map"):
                cn["map"] = _copy_into(str(cn["map"]), folder, used)
        except FileNotFoundError as exc:
            return _error("Slot {}: file not found ({})".format(i + 1, exc))
        slots.append({"file": file, "on": bool(slot.get("on")) and bool(file),
                      "cn": cn if file else None})

    content = {"kind": PROJECT_KIND, "version": 1, "project": safe, "slots": slots}
    # scene: lo que otros nodos Academia guardan con el proyecto (los prompts).
    for key in ("place", "cropPos", "heroH", "cnRes", "widgets", "scene"):
        if key in state:
            content[key] = state[key]

    path = os.path.join(folder, safe + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(content, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)
    return web.json_response({"status": "success", "project": safe,
                              "images": sum(1 for s in slots if s["file"])})


@PromptServer.instance.routes.get("/academia/multiref/load")
async def multiref_load(request):
    safe, folder = _project_dir(request.query.get("name"))
    data = _read_project(folder, safe) if folder else None
    if data is None:
        return _error("Project not found", 404)
    # Los nombres van relativos a input/, que es como los guarda el nodo.
    missing = []
    for i, slot in enumerate(data.get("slots") or []):
        if not isinstance(slot, dict):
            continue
        cn = slot.get("cn") if isinstance(slot.get("cn"), dict) else {}
        for owner, key in ((slot, "file"), (cn, "map")):
            if owner.get(key):
                if not os.path.isfile(os.path.join(folder, owner[key])) and i + 1 not in missing:
                    missing.append(i + 1)
                owner[key] = "{}/{}".format(safe, owner[key])
    return web.json_response({"status": "success", "project": safe, "data": data, "missing": missing})


@PromptServer.instance.routes.post("/academia/multiref/keepmap")
async def multiref_keepmap(request):
    """Lleva el mapa que Preview Image acaba de dejar en temp/ junto a su imagen
    original en input/, como <nombre>_<sufijo>.png.

    `replace` es el mapa que ya tenia esa ranura: se pisa, que si no cada
    prueba de ajustes dejaria un fichero mas. Cualquier otro que se llame igual
    es de otra ranura y no se toca; el nuevo lleva _02, _03...
    """
    body = await request.json()
    image = body.get("image") if isinstance(body.get("image"), dict) else {}
    temp = os.path.abspath(folder_paths.get_temp_directory())
    src = os.path.abspath(os.path.join(temp, str(image.get("subfolder") or ""), str(image.get("filename") or "")))
    if image.get("type") != "temp" or os.path.commonpath([temp, src]) != temp or not os.path.isfile(src):
        return _error("Map not found")

    base = _input_dir()
    orig = os.path.abspath(folder_paths.get_annotated_filepath(str(body.get("source") or "")))
    suffix = _sanitize_project(body.get("suffix")).replace(" ", "_")
    if os.path.commonpath([base, orig]) != base or not suffix:
        return _error("Bad request")

    folder, stem = os.path.dirname(orig), os.path.splitext(os.path.basename(orig))[0]
    rel = lambda name: os.path.relpath(os.path.join(folder, name), base).replace(os.sep, "/")
    replace = str(body.get("replace") or "")
    name, n = "{}_{}.png".format(stem, suffix), 2
    while os.path.exists(os.path.join(folder, name)) and rel(name) != replace:
        name = "{}_{}_{:02d}.png".format(stem, suffix, n)
        n += 1
    shutil.copyfile(src, os.path.join(folder, name))
    return web.json_response({"status": "success", "file": rel(name)})


@PromptServer.instance.routes.post("/academia/multiref/open")
async def multiref_open(request):
    """Abre input/<proyecto> en el explorador. Como en Moviola: solo Windows, y
    en la maquina que corre ComfyUI, no en la del navegador."""
    body = await request.json()
    safe, folder = _project_dir(body.get("name"))
    if folder is None or _read_project(folder, safe) is None:
        return _error("Not a saved project -- press Save first")
    if not hasattr(os, "startfile"):
        return _error("Opening a folder is Windows only: input/{}".format(safe))
    try:
        os.startfile(folder)
    except OSError as exc:
        return _error("Could not open input/{}: {}".format(safe, exc.strerror or exc))
    return web.json_response({"status": "success", "project": safe})


@PromptServer.instance.routes.get("/academia/multiref/inspect")
async def multiref_inspect(request):
    """Que se va a borrar, ANTES de borrarlo, para que el aviso lo pueda decir."""
    safe, folder = _project_dir(request.query.get("name"))
    if folder is None or _read_project(folder, safe) is None:
        return web.json_response({"status": "success", "project": safe, "exists": False})
    files, size = 0, 0
    for root, _, names in os.walk(folder):
        for n in names:
            files += 1
            size += os.path.getsize(os.path.join(root, n))
    return web.json_response({"status": "success", "project": safe, "exists": True,
                              "files": files, "bytes": size})


@PromptServer.instance.routes.post("/academia/multiref/delete")
async def multiref_delete(request):
    # Llega un NOMBRE, nunca una ruta: la carpeta se reconstruye aqui con la
    # misma regla que la creo.
    body = await request.json()
    safe, folder = _project_dir(body.get("name"))
    if folder is None or _read_project(folder, safe) is None:
        return _error("Not a Multi Image Reference project")
    try:
        shutil.rmtree(folder)
    except OSError as exc:
        return _error("Could not delete input/{}: {}".format(safe, exc.strerror or exc))
    return web.json_response({"status": "success", "project": safe})


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MultiImageReference": AcademiaMultiImageReference,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MultiImageReference": "Academia SD Multi Image Reference 🖼️",
}
