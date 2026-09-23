import json
import os

from aiohttp import web
from server import PromptServer

# La carpeta de salida del proyecto se pide a ComfyUI, no se adivina: quien la
# haya movido con --output-directory tiene que seguir borrando la suya.
#
# The project's output folder is asked of ComfyUI rather than guessed: whoever
# moved it with --output-directory must still be deleting their own.
try:
    import folder_paths
except Exception:
    folder_paths = None

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


def _carpeta_salida(nombre):
    """output/<proyecto>: donde cuelga TODO lo que genera ese proyecto.

    La regla de verdad esta en `AcademiaProjectPaths.rutas`, que devuelve
    '<proyecto>/loop', '<proyecto>/vid_loop' y '<proyecto>/vid_int_loop'. Los tres
    caen dentro de output/<proyecto>, asi que esa carpeta es el proyecto entero en
    disco y es lo que hay que quitar.

    Devuelve None -- y quien llama se para en seco -- si no hay nombre, si no se
    sabe donde esta output/, o si lo que sale no es un descendiente suyo. El
    nombre ya viene de `sanitize_project`, que no deja sobrevivir barras ni
    puntos, asi que la ultima comprobacion no deberia poder fallar nunca: esta
    porque lo que hay al otro lado es un borrado recursivo.

    Returns None -- and the caller stops -- with no name, with no known output
    directory, or if the result is not a descendant of it. The name has already
    been through `sanitize_project`, so the last check should be unreachable: it
    is there because what happens next is a recursive delete.
    """
    seguro = sanitize_project(nombre)
    if not seguro or folder_paths is None:
        return None
    try:
        raiz = os.path.abspath(folder_paths.get_output_directory())
    except Exception:
        return None
    destino = os.path.abspath(os.path.join(raiz, seguro))
    if destino == raiz or os.path.commonpath([raiz, destino]) != raiz:
        return None
    return destino


def _medida(carpeta):
    """(ficheros, bytes) de todo el arbol, para poder DECIR que se va a borrar.

    El aviso del navegador lo recita antes de preguntar. Un boton que borra sin
    decir cuanto se lleva no es un aviso, es un tramite.
    """
    n, total = 0, 0
    for raiz, _, ficheros in os.walk(carpeta):
        for f in ficheros:
            n += 1
            try:
                total += os.path.getsize(os.path.join(raiz, f))
            except OSError:
                pass
    return n, total


def _arrasar(carpeta):
    """Borra el arbol de abajo arriba. Devuelve (ficheros, bytes, fallos).

    A mano y no con `shutil.rmtree` por dos razones. Su `onerror` esta deprecado
    desde 3.12 y cambia de firma, y sobre todo: en Windows lo normal no es que
    falle el borrado entero, es que falle UN fichero porque algo lo tiene
    abierto. Decir cual es la diferencia entre reintentar y rendirse.

    By hand rather than with `shutil.rmtree`: its `onerror` is deprecated since
    3.12, and on Windows the usual failure is not the whole tree but ONE file
    something still holds open. Naming it is the difference between retrying and
    giving up.
    """
    n, octetos, fallos = 0, 0, []
    for raiz, dirs, ficheros in os.walk(carpeta, topdown=False):
        for f in ficheros:
            completo = os.path.join(raiz, f)
            try:
                tam = os.path.getsize(completo)
            except OSError:
                tam = 0
            try:
                os.remove(completo)
                n += 1
                octetos += tam
            except OSError as exc:
                fallos.append("{}: {}".format(f, exc.strerror or exc))
        # De abajo arriba, asi que al llegar aqui ya estan vacias -- salvo que
        # algo de dentro no se fuera, y eso ya tiene su linea.
        for d in dirs:
            try:
                os.rmdir(os.path.join(raiz, d))
            except OSError:
                pass
    try:
        os.rmdir(carpeta)
    except OSError as exc:
        if os.path.isdir(carpeta):
            fallos.append("{}: {}".format(os.path.basename(carpeta), exc.strerror or exc))
    return n, octetos, fallos


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


@PromptServer.instance.routes.get("/academia/multiprompt/inspect")
async def inspect_project(request):
    """Que hay que borrar, ANTES de borrarlo.

    No toca nada. Existe para que el aviso del navegador pueda nombrar las dos
    cosas que se va a llevar y cuanto pesan, en vez de preguntar a ciegas.
    Read-only: it exists so the browser's warning can name both things it is
    about to remove, and their size, instead of asking blind.
    """
    nombre = sanitize_project(request.query.get("name"))
    ruta = _project_path(nombre)
    if not nombre or ruta is None:
        return web.json_response({"status": "error", "message": "Invalid name"}, status=400)

    hay_json = os.path.isfile(ruta)
    cuantos = None
    if hay_json:
        try:
            with open(ruta, "r", encoding="utf-8") as f:
                cuantos = len(json.load(f).get("prompts") or [])
        except Exception:
            # Ilegible sigue siendo borrable, y de hecho es un motivo para
            # borrarlo. Solo se pierde la cuenta que sale en el aviso.
            cuantos = None

    carpeta = _carpeta_salida(nombre)
    hay_carpeta = bool(carpeta) and os.path.isdir(carpeta)
    ficheros, octetos = _medida(carpeta) if hay_carpeta else (0, 0)

    return web.json_response({
        "status": "success",
        "project": nombre,
        "prompts_file": hay_json,
        "prompts": cuantos,
        "folder": os.path.basename(carpeta) if carpeta else None,
        "folder_exists": hay_carpeta,
        "files": ficheros,
        "bytes": octetos,
    })


@PromptServer.instance.routes.post("/academia/multiprompt/delete")
async def delete_project(request):
    """Se lleva el .json de los prompts Y la carpeta de salida entera.

    Un proyecto son dos cosas en dos sitios: el guion, aqui al lado del nodo, y
    las tomas, bajo output/. Borrar solo una deja la otra huerfana -- prompts que
    apuntan a nada, o una carpeta de tomas que ya no se puede seleccionar desde
    el nodo -- asi que se van las dos o se avisa de por que no.

    Llega un NOMBRE, nunca una ruta: las dos rutas se reconstruyen aqui con la
    misma regla que las escribio. Una ruta que viniera del navegador seria una
    ruta que el navegador elige, y al otro lado hay un borrado recursivo.

    A project is two things in two places: the script, next to the node, and the
    takes, under output/. Removing only one orphans the other. A NAME arrives,
    never a path: both paths are rebuilt here with the same rule that wrote them.
    """
    try:
        cuerpo = await request.json()
    except Exception:
        return web.json_response({"status": "error", "message": "Bad request"}, status=400)

    nombre = sanitize_project(cuerpo.get("name"))
    ruta = _project_path(nombre)
    carpeta = _carpeta_salida(nombre)
    if not nombre or ruta is None or carpeta is None:
        return web.json_response(
            {"status": "error", "message": "Invalid project name"}, status=400)

    fallos = []
    ficheros, octetos = 0, 0
    if os.path.isdir(carpeta):
        ficheros, octetos, fallos = _arrasar(carpeta)
    sobra_carpeta = os.path.isdir(carpeta)

    # El .json se va DESPUES, y solo si la carpeta se fue entera. Si algo sigue
    # abierto el proyecto se queda en la lista y se puede reintentar; sin el
    # .json seria una carpeta a medio borrar que ya no se puede ni seleccionar.
    #
    # The .json goes LAST, and only if the folder went completely. If something
    # is still open the project stays in the list and can be retried; without
    # the .json it would be a half-deleted folder nobody can select any more.
    json_fuera = False
    if not sobra_carpeta and os.path.isfile(ruta):
        try:
            os.remove(ruta)
            json_fuera = True
        except OSError as exc:
            fallos.append("{}.json: {}".format(nombre, exc.strerror or exc))

    try:
        restantes = sorted(f[:-5] for f in os.listdir(PROJECTS_DIR) if f.endswith(".json"))
    except OSError:
        restantes = []

    print("[AcademiaSD] 🗑 Delete Project '{}': {} file(s), {:.1f} MB, "
          "prompts {}{}".format(nombre, ficheros, octetos / 1048576.0,
                                "deleted" if json_fuera else "kept",
                                "" if not fallos else " -- {} PROBLEM(S)".format(len(fallos))))
    for f in fallos:
        print("[AcademiaSD]    could not remove {}".format(f))

    return web.json_response({
        "status": "success",
        "project": nombre,
        "complete": not fallos,
        "files": ficheros,
        "bytes": octetos,
        "prompts_deleted": json_fuera,
        "errors": fallos,
        "remaining": restantes,
    })


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
