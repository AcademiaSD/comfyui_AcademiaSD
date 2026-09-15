import json
import os

from aiohttp import web
from server import PromptServer

# Los proyectos viven junto al nodo, no en output/: son la RECETA de una serie
# (los prompts y su cabecera comun), no material generado. Vaciar output/ no
# deberia llevarse por delante el guion de un proyecto de diez tomas.
#
# Projects live next to the node, not under output/: they are a series' RECIPE
# (its prompts and shared header), not generated material. Emptying output/
# should not take the script of a ten-take project with it.
PROJECTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "prompt_projects")
try:
    os.makedirs(PROJECTS_DIR, exist_ok=True)
except OSError:
    # En una instalacion de solo lectura esto fallaria al importar y se llevaria
    # por delante el nodo entero. Guardar proyectos dejara de funcionar y lo dira
    # al intentarlo, pero los prompts del workflow siguen yendo.
    # On a read-only install this would fail at import and take the whole node
    # down with it. Saving projects will fail and say so; the workflow's own
    # prompts keep working.
    pass


def sanitize_project(name):
    """Deja el nombre en algo que valga como carpeta y como fichero a la vez.

    MISMA regla que `AcademiaProjectPaths.sanitize_project`, que la usa para
    construir las rutas de salida. Si se toca una hay que tocar la otra: en
    cuanto dejen de coincidir, la carpeta de salida y el fichero de prompts del
    mismo proyecto acabarian llamandose distinto.
    SAME rule as `AcademiaProjectPaths.sanitize_project`, which builds the output
    paths. Change one, change the other.

    El nombre sale de una caja de texto y acaba en DOS sitios distintos: en una
    ruta de salida que se le pasa a los nodos de guardado, y en el nombre de un
    .json de este directorio. Cualquier `..`, barra o dos puntos que sobreviva
    basta para escribir donde no toca, asi que se filtra por lista blanca y no
    tachando lo que se sabe malo.

    Trims the name to something usable as both folder and filename. It ends up
    in an output path AND in a .json name here, so any surviving `..`, slash or
    colon would be enough to write outside the intended place: filtered by
    allow-list rather than by blocking known-bad characters.
    """
    if not name:
        return ""
    limpio = "".join(c for c in str(name) if c.isalnum() or c in (" ", "-", "_"))
    return limpio.strip()


def _project_path(name):
    """Ruta de <name>.json dentro de PROJECTS_DIR, o None si se sale de ahi."""
    seguro = sanitize_project(name)
    if not seguro:
        return None
    base = os.path.abspath(PROJECTS_DIR)
    destino = os.path.abspath(os.path.join(base, "{}.json".format(seguro)))
    if os.path.commonpath([base, destino]) != base:
        return None
    return destino


# --- RUTAS DE API ---
@PromptServer.instance.routes.get("/academia/multiprompt/list")
async def list_projects(request):
    try:
        ficheros = [f[:-5] for f in os.listdir(PROJECTS_DIR) if f.endswith(".json")]
        return web.json_response({"status": "success", "files": sorted(ficheros)})
    except Exception:
        return web.json_response(
            {"status": "error", "message": "Could not list the projects"}, status=400)


@PromptServer.instance.routes.get("/academia/multiprompt/load")
async def load_project(request):
    ruta = _project_path(request.query.get("name"))
    if ruta is None:
        return web.json_response({"status": "error", "message": "Invalid name"}, status=400)
    if not os.path.exists(ruta):
        return web.json_response({"status": "error", "message": "Project not found"}, status=404)
    try:
        with open(ruta, "r", encoding="utf-8") as f:
            return web.json_response({"status": "success", "data": json.load(f)})
    except Exception:
        return web.json_response(
            {"status": "error", "message": "Could not read the project"}, status=400)


@PromptServer.instance.routes.post("/academia/multiprompt/save")
async def save_project(request):
    try:
        cuerpo = await request.json()
        ruta = _project_path(cuerpo.get("name"))
        if ruta is None:
            return web.json_response({"status": "error", "message": "Invalid name"}, status=400)

        prompts = cuerpo.get("prompts")
        if not isinstance(prompts, list):
            return web.json_response(
                {"status": "error", "message": "prompts must be a list"}, status=400)

        contenido = {
            "version": 1,
            "global_prompt": str(cuerpo.get("global_prompt", "")),
            "prompts": [{"text": str(p.get("text", ""))} for p in prompts if isinstance(p, dict)],
        }

        # Escritura atomica: un corte a mitad de volcado dejaria el proyecto
        # ilegible, y ahi esta el guion entero de una serie.
        # Atomic write: a crash mid-dump would leave the project unreadable, and
        # it holds the whole script of a series.
        tmp = ruta + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(contenido, f, indent=2, ensure_ascii=False)
        os.replace(tmp, ruta)

        return web.json_response({"status": "success", "count": len(contenido["prompts"])})
    except Exception:
        return web.json_response(
            {"status": "error", "message": "Could not save the project"}, status=400)


class AcademiaMultiPrompt:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "index": ("INT", {"default": 1, "min": 1, "max": 1000, "step": 1}),
                "prompt_data": ("STRING", {"default": "[]"}),  # JSON Oculto
            },
            # En `optional` para que los workflows guardados antes de que estos
            # campos existieran sigan cargando con sus valores por defecto, en
            # vez de quejarse de entradas que faltan.
            # Optional so workflows saved before these fields existed keep
            # loading, with their defaults, instead of complaining.
            "optional": {
                "project_name": ("STRING", {"default": ""}),
                "global_prompt": ("STRING", {"default": ""}),
            },
        }

    # Las rutas NO salen de aqui: viven en AcademiaSD_ProjectPaths, que no tiene
    # entradas. Este nodo recibe `index` de Moviola In, asi que cualquier salida
    # suya que volviera a Moviola In cerraria un ciclo y el grafo de ComfyUI es
    # aciclico. `project_name` sigue estando porque nombra el .json del proyecto
    # al guardarlo y cargarlo, y puede venir enlazado desde ProjectPaths para que
    # el nombre se escriba en un solo sitio.
    #
    # The paths do NOT come out of here: they live in AcademiaSD_ProjectPaths,
    # which has no inputs. This node takes `index` from Moviola In, so any output
    # of its own going back there would close a cycle. `project_name` stays
    # because it names the project's .json, and it can be linked from
    # ProjectPaths so the name is typed in one place only.
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "get_prompt"
    CATEGORY = "Academia SD"

    def get_prompt(self, index, prompt_data="[]", project_name="", global_prompt=""):
        try:
            prompts = json.loads(prompt_data)
        except Exception:
            prompts = []

        if not prompts:
            return ("",)

        # El index viene de base 1 (Loop 1, Loop 2...). En programación es base 0.
        target_idx = index - 1

        # Si el índice es menor a 1, forzamos al primer prompt
        if target_idx < 0:
            target_idx = 0

        # Si el índice supera la cantidad de prompts que el usuario ha escrito,
        # mantenemos el último prompt disponible para que el vídeo no se rompa o se vuelva negro.
        if target_idx >= len(prompts):
            target_idx = len(prompts) - 1

        selected_prompt = prompts[target_idx].get("text", "")

        # El prompt global va DELANTE, no detrás: es la cabecera que comparten
        # todas las tomas de una serie -- quién es el sujeto, el aspecto visual --
        # y ese bloque se lee mal después de la acción. Escribirlo una sola vez
        # aquí evita repetirlo en las diez cajas y, sobre todo, evita que las
        # diez copias diverjan cuando se edita una.
        #
        # The global prompt goes FIRST, not last: it is the header every take in
        # a series shares -- who the subject is, the look -- and that block reads
        # wrong after the action. Writing it once here keeps ten copies from
        # drifting apart when only one of them gets edited.
        cabecera = (global_prompt or "").strip()
        if cabecera:
            selected_prompt = "{}\n\n{}".format(cabecera, selected_prompt.lstrip())

        print("[AcademiaSD] 📝 Loop {} -> Injecting Prompt {}{}".format(
            index, target_idx + 1, " (+global)" if cabecera else ""))

        return (selected_prompt,)


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MultiPrompt": AcademiaMultiPrompt
}
# Solo cambia el nombre VISIBLE. La clave `AcademiaSD_MultiPrompt` es lo que
# guardan los workflows, asi que tocarla dejaria sin cargar todos los que ya
# existen ahi fuera.
# Display name only. The `AcademiaSD_MultiPrompt` key is what workflows store,
# so renaming it would break every one already out there.
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MultiPrompt": "Academia SD Moviola Multi-prompts 📝"
}
