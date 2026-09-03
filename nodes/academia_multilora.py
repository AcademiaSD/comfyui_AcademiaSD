import os
import json
import struct
import comfy.sd
import comfy.utils
import folder_paths
from server import PromptServer
from aiohttp import web
import asyncio

# --- NUEVA API: Leer Metadatos del LoRA en milisegundos ---

# Claves que se muestran con nombre legible y en un orden fijo, agrupadas.
# Todo lo que NO este aqui se vuelca igualmente al final, en OTHER: la gracia de
# esta ventana es ver lo que trae el fichero, y una lista blanca que se comiera
# las claves desconocidas dejaria fuera precisamente los LoRA de otros
# entrenadores, que es cuando mas falta hace mirar.
GRUPOS = [
    ("\u2699\uFE0F", "TRAINING", [
        ("ss_network_module",            "Network"),
        ("ss_network_dim",               "Dim"),
        ("ss_network_alpha",             "Alpha"),
        ("ss_learning_rate",             "Learning rate"),
        ("ss_unet_lr",                   "UNet LR"),
        ("ss_text_encoder_lr",           "TE LR"),
        ("ss_lr_scheduler",              "Scheduler"),
        ("ss_lr_warmup_steps",           "Warmup"),
        ("ss_optimizer",                 "Optimizer"),
        ("ss_max_train_steps",           "Steps"),
        ("ss_epoch",                     "Epochs"),
        ("ss_num_train_images",          "Images"),
        ("ss_batch_size_per_device",     "Batch"),
        ("ss_gradient_accumulation_steps", "Grad accum"),
        ("ss_mixed_precision",           "Precision"),
        ("ss_seed",                      "Seed"),
        ("ss_noise_offset",              "Noise offset"),
        ("ss_clip_skip",                 "Clip skip"),
    ]),
    ("\U0001F3AC", "DATA", [
        ("ss_resolution",                "Resolution"),
        ("ss_num_frames",                "Frames"),
        ("ss_num_batches_per_epoch",     "Batches/epoch"),
        ("ss_num_reg_images",            "Reg images"),
        ("ss_keep_tokens",               "Keep tokens"),
        ("ss_shuffle_caption",           "Shuffle caption"),
    ]),
    ("\U0001F527", "FORMAT", [
        ("format",                       "Format"),
        ("lora_key_prefix",              "Key prefix"),
        ("qkv_fused",                    "QKV fused"),
        ("swiglu_fc1_halves_swapped",    "SwiGLU swapped"),
        ("baked_scaling",                "Baked scaling"),
        ("modelspec.implementation",     "Implementation"),
    ]),
]

# Cabecera: van sueltas arriba, sin etiqueta de grupo.
CABECERA = [
    ("ss_output_name",        "\U0001F4E6"),   # nombre del LoRA
    ("project_name",          "\U0001F4E6"),
    ("trained_with",          "\U0001F3ED"),   # con que se entreno
    ("ss_sd_model_name",      "\U0001F9E0"),   # modelo base
    ("ss_base_model_version", "\U0001F9E0"),
]

# Claves ya consumidas por la cabecera, los grupos o el bloque de tags: no se
# repiten en OTHER.
YA_MOSTRADAS = set(k for k, _ in CABECERA)
for _ico, _tit, pares in GRUPOS:
    YA_MOSTRADAS.update(k for k, _ in pares)
YA_MOSTRADAS.update({"trigger_word", "ss_tag_frequency", "modelspec.trigger_words"})

# El tooltip no tiene barra de desplazamiento (pointer-events: none), asi que
# un LoRA de Kohya con ss_bucket_info entero lo mandaria fuera de la pantalla.
MAX_VALOR = 68      # caracteres por valor antes de recortar
MAX_LINEAS = 46     # lineas totales antes de resumir el resto


def _corta(valor, limite=MAX_VALOR):
    """Deja el valor en una linea. Los JSON largos se resumen por su tamano."""
    v = str(valor).replace("\n", " ").strip()
    if len(v) <= limite:
        return v
    # Un JSON no se entiende cortado por la mitad; mejor decir cuanto ocupa.
    if v[:1] in "[{":
        return "{}... ({} chars)".format(v[:limite - 18], len(v))
    return v[:limite - 3] + "..."


def read_lora_metadata(lora_path):
    if not lora_path or not os.path.exists(lora_path):
        return "File not found."
    if not lora_path.endswith(".safetensors"):
        return "Metadata reading is only supported for .safetensors files."

    try:
        with open(lora_path, "rb") as f:
            # Los primeros 8 bytes de un safetensors indican el tamano del JSON
            # del header. Leerlo es instantaneo: no carga los pesos.
            header_size = struct.unpack("<Q", f.read(8))[0]
            header = json.loads(f.read(header_size).decode("utf-8"))

        metadata = header.get("__metadata__", {})
        if not metadata:
            return "No training metadata found in this LoRA."

        out = []

        # ---------------------------------------------------------- cabecera
        vistas = set()
        for clave, icono in CABECERA:
            v = metadata.get(clave)
            if v and str(v) not in vistas:
                vistas.add(str(v))
                out.append("{}  {}".format(icono, _corta(v)))

        # ----------------------------------------------------------- trigger
        # Dos sitios posibles. trigger_word es el que escribe LoRAlab;
        # ss_tag_frequency es el que lee CivitAI, y de ahi salen las tags.
        tags = {}
        crudo = metadata.get("ss_tag_frequency", "")
        if crudo:
            try:
                for _ds, ds_tags in json.loads(crudo).items():
                    for tag, count in ds_tags.items():
                        tags[tag] = tags.get(tag, 0) + count
            except Exception:
                pass

        trigger = metadata.get("trigger_word") or metadata.get("modelspec.trigger_words", "")
        if trigger:
            out.append("")
            out.append("\U0001F3F7\uFE0F  TRIGGER")
            out.append("    " + _corta(trigger))

        if tags:
            orden = sorted(tags.items(), key=lambda x: (-x[1], x[0]))
            # Con recuentos si aportan algo; si todos valen 1, solo los nombres.
            if any(c > 1 for _t, c in orden):
                lista = ", ".join("{} ({})".format(t, c) for t, c in orden[:20])
            else:
                lista = ", ".join(t for t, _c in orden[:20])
            if len(orden) > 20:
                lista += ", +{} more".format(len(orden) - 20)
            out.append("")
            out.append("\U0001F3F7\uFE0F  TAGS ({})".format(len(orden)))
            # Se parte a mano porque el tooltip usa pre-wrap y una linea larga
            # ensancharia el recuadro hasta su max-width.
            linea = "    "
            for trozo in lista.split(", "):
                if len(linea) + len(trozo) > 54:
                    out.append(linea.rstrip(", "))
                    linea = "    "
                linea += trozo + ", "
            if linea.strip(" ,"):
                out.append(linea.rstrip(", "))

        # ------------------------------------------------------------ grupos
        for icono, titulo, pares in GRUPOS:
            filas = [(et, metadata[c]) for c, et in pares if metadata.get(c) not in (None, "")]
            if not filas:
                continue
            out.append("")
            out.append("{}  {}".format(icono, titulo))
            ancho = max(len(et) for et, _ in filas)
            for et, v in filas:
                out.append("    {}  {}".format(et.ljust(ancho),
                                               _corta(v, max(20, MAX_VALOR - ancho))))

        # ------------------------------------------------------------- resto
        # Aqui esta la diferencia con la version anterior, que solo enseñaba
        # modelo base, resolucion y tags y se callaba todo lo demas.
        resto = sorted(k for k in metadata if k not in YA_MOSTRADAS)
        if resto:
            out.append("")
            out.append("\U0001F4C4  OTHER ({})".format(len(resto)))
            ancho = min(26, max(len(k) for k in resto))
            for k in resto:
                out.append("    {}  {}".format(k.ljust(ancho),
                                               _corta(metadata[k], max(20, MAX_VALOR - ancho))))

        # El tooltip no hace scroll: si aun asi sale kilometrico, se corta.
        if len(out) > MAX_LINEAS:
            sobran = len(out) - MAX_LINEAS
            out = out[:MAX_LINEAS] + ["", "    ... +{} more lines".format(sobran)]

        return "\n".join(out) if out else "Metadata exists, but it is empty."

    except Exception as e:
        return "Error reading metadata: {}".format(e)


@PromptServer.instance.routes.post("/academia/lora_info")
async def get_lora_info(request):
    data = await request.json()
    lora_name = data.get("name")
    if not lora_name or lora_name == "None":
        return web.json_response({"info": "No LoRA selected."})

    lora_path = folder_paths.get_full_path("loras", lora_name)
    # Lo ejecutamos en segundo plano para no bloquear ComfyUI
    info = await asyncio.to_thread(read_lora_metadata, lora_path)
    return web.json_response({"info": info})

@PromptServer.instance.routes.get("/academia/lora_list")
async def get_lora_list(request):
    loras = folder_paths.get_filename_list("loras")
    return web.json_response(loras)

class AcademiaMultiLoraNode:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "injection_method": (["Standard (Native)", "Model Only (No CLIP)"],),
                "lora_data": ("STRING", {"default": "[]"}),
            },
            "optional": {
                "clip": ("CLIP", {"default": None}),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "apply_loras"
    CATEGORY = "Academia SD"

    def apply_loras(self, model, injection_method, lora_data="[]", clip=None):
        try:
            loras = json.loads(lora_data)
        except:
            loras = []

        if not loras:
            return (model, clip)

        print(f"[AcademiaSD] Starting Multi-LoRA Injection...")

        for lora in loras:
            if not lora.get("enabled", True):
                continue

            lora_name = lora.get("name")
            if not lora_name or lora_name == "None":
                continue

            strength = float(lora.get("strength", 1.0))
            if strength == 0.0:
                print(f"[AcademiaSD] ⏩ Skipping: {lora_name} (Strength is 0)")
                continue

            lora_path = folder_paths.get_full_path("loras", lora_name)
            if not lora_path:
                print(f"[AcademiaSD] ❌ Warning: Could not find LoRA file: {lora_name}")
                continue

            print(f"[AcademiaSD] 💉 Injecting: {lora_name} (Strength: {strength})")
            
            try:
                lora_tensor = comfy.utils.load_torch_file(lora_path, safe_load=True)
            except Exception as e:
                print(f"[AcademiaSD] ❌ Error loading LoRA data for {lora_name}: {e}")
                continue
            
            strength_model = strength
            strength_clip = strength if (injection_method == "Standard (Native)" and clip is not None) else 0.0
            
            lora_model, lora_clip = comfy.sd.load_lora_for_models(
                model, clip, lora_tensor, strength_model, strength_clip
            )
            
            if lora_model is not None:
                model = lora_model
            if lora_clip is not None and clip is not None:
                clip = lora_clip

        return (model, clip)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MultiLora": AcademiaMultiLoraNode
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MultiLora": "Academia SD Multi-LoRA 💊"
}