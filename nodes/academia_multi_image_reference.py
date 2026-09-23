import os
import json
import hashlib

import numpy as np
import torch
from PIL import Image, ImageOps

import comfy.utils
import folder_paths
import node_helpers

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
# disabled estira hasta el destino, deformando            (common_upscale nativo)
#
# center se deja intacto a proposito, delegando en ComfyUI: los workflows que ya
# lo usan tienen que seguir dando el pixel exacto de antes.
CROP_METHODS = ["center", "custom", "pad", "disabled"]

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
                "crop": (CROP_METHODS, {"default": "center"}),
                # Solo pinta en modo pad. Admite "#RRGGBB", "RRGGBB", "#RGB" o
                # los nombres white / black / grey.
                "pad_color": ("STRING", {"default": "#FFFFFF"}),
                # Con el interruptor apagado la imagen va centrada y entera, que
                # es el relleno de toda la vida. Encendido, manda la colocacion
                # que se haya arrastrado en el panel: eso es el outpaint.
                "outpaint": ("BOOLEAN", {"default": False,
                                         "label_on": "Outpaint ON",
                                         "label_off": "Outpaint OFF"}),
            },
        }

    # Reference_active va la ULTIMA a proposito: los enlaces guardados apuntan
    # al slot por NUMERO, asi que anadir al final deja image_1..image_10 donde
    # estaban y nadie tiene que recablear.
    RETURN_TYPES = ("IMAGE",) * SLOT_COUNT + ("INT",)
    RETURN_NAMES = (tuple("image_{}".format(i) for i in range(1, SLOT_COUNT + 1))
                    + ("Reference_active",))
    FUNCTION = "load_references"
    CATEGORY = "Academia SD"

    # --- ESTADO ---

    @staticmethod
    def _slots(refs_data):
        """Siempre SLOT_COUNT ranuras {file, on}, venga lo que venga en el JSON."""
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
            out.append({
                "file": str(item.get("file") or ""),
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
        """"#RRGGBB", "RRGGBB", "#RGB" o un nombre. Lo que no se entienda, blanco."""
        t = str(text or "").strip().lower().lstrip("#")
        t = NAMED_COLORS.get(t, t)
        if len(t) == 3:
            t = "".join(c * 2 for c in t)
        if len(t) != 6:
            return (1.0, 1.0, 1.0)
        try:
            return tuple(int(t[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
        except ValueError:
            return (1.0, 1.0, 1.0)

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
                pad_color="#FFFFFF", outpaint=False, place=(0.5, 0.5, 1.0),
                crop_pos=(0.5, 0.5)):
        if image is None or width <= 0 or height <= 0:
            return image
        tw, th = int(width), int(height)

        # center y disabled son literalmente el Upscale Image nativo.
        if crop in ("center", "disabled"):
            samples = image.movedim(-1, 1)                  # NHWC -> NCHW
            return comfy.utils.common_upscale(samples, tw, th, scale_method, crop).movedim(1, -1)

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
                        scale_method="lanczos", crop="center",
                        pad_color="#FFFFFF", outpaint=False):
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
    def IS_CHANGED(s, refs_data="", width=0, height=0, scale_method="lanczos", crop="center",
                   pad_color="#FFFFFF", outpaint=False):
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
    def VALIDATE_INPUTS(s, refs_data="", width=0, height=0, scale_method="lanczos", crop="center",
                        pad_color="#FFFFFF", outpaint=False):
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


_DISPLAY = "Academia SD Multi Image Reference 🖼️"

class _AcademiaQwenRefImagesLegacy(AcademiaMultiImageReference):
    """El nombre viejo del nodo. No hace nada distinto: solo existe para que los
    workflows guardados antes del renombrado sigan abriendo, en vez de dejar el
    nodo en rojo y obligar a recablear diez salidas a mano.

    DEPRECATED lo esconde del buscador de nodos. Sin esto salia DOS VECES en la
    lista, porque son dos claves registradas con el mismo nombre visible.
    Se puede borrar esta clase cuando esos workflows se hayan vuelto a guardar.
    """
    DEPRECATED = True


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MultiImageReference": AcademiaMultiImageReference,
    "AcademiaSD_QwenRefImages": _AcademiaQwenRefImagesLegacy,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MultiImageReference": _DISPLAY,
    "AcademiaSD_QwenRefImages": _DISPLAY,
}
