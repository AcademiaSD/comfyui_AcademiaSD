from aiohttp import web
from server import PromptServer


@PromptServer.instance.routes.post("/academia/projectpaths/resolve")
async def resolver_rutas(request):
    """Las mismas rutas que calcularia el nodo, pero pedidas desde el navegador.

    Existe para que nadie tenga que reimplementar la regla en JavaScript. El
    Film Editor necesita saber a que proyecto apunta ANTES de borrar nada, y su
    entrada `path` suele venir enlazada de aqui: un enlace solo tiene valor
    durante la ejecucion, asi que la interfaz pregunta y esta ruta contesta con
    lo mismo que saldria por el zocalo.

    So nobody has to reimplement the rule in JavaScript. The Film Editor needs to
    know which project it points at BEFORE deleting anything, and its `path`
    input usually comes from here; a link only has a value during execution, so
    the UI asks and this answers exactly what the connector would carry.
    """
    try:
        datos = await request.json()
        salida = AcademiaProjectPaths().rutas(datos.get("project_name", ""))
        return web.json_response({
            "status": "success",
            "project_name": salida[0],
            "path": salida[1],
            "vid_path": salida[2],
            "vid_int_loop": salida[3],
        })
    except Exception as exc:
        return web.json_response({"status": "error", "message": str(exc)}, status=400)


class AcademiaProjectPaths:
    """Un solo nombre de proyecto, arriba del todo, del que cuelgan las rutas.

    Este nodo existe por una razon de forma del grafo, no de comodidad. Moviola
    In calcula `next_index` leyendo el disco y ese indice alimenta al
    Multi-Prompt; mientras eso sea asi, el Multi-Prompt NO puede devolverle nada
    a Moviola In, porque cerraria un ciclo y el grafo de ComfyUI es aciclico.
    Sacar las rutas de ahi y ponerlas en un nodo SIN entradas rompe el problema
    de raiz: lo que no depende de nadie puede alimentar a todo el mundo.

    This node exists because of the graph's shape, not for convenience. Moviola
    In computes `next_index` from disk and that index feeds the Multi-Prompt, so
    the Multi-Prompt can never feed Moviola In back without closing a cycle, and
    ComfyUI's graph is acyclic. Moving the paths into a node with NO inputs
    settles it at the root: what depends on nothing can feed everything.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "project_name": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("project_name", "path", "vid_path", "vid_int_loop")
    FUNCTION = "rutas"
    CATEGORY = "Academia SD"

    SUFIJOS = ("loop", "vid_loop", "vid_int_loop")

    @staticmethod
    def sanitize_project(name):
        """Deja el nombre en algo que valga como carpeta y como fichero a la vez.

        MISMA regla que `sanitize_project` en academia_multi_prompt.py, que la
        necesita para nombrar el .json del proyecto. Si se toca una, tocar la
        otra: si dejaran de coincidir, la carpeta de salida y el fichero de
        prompts del mismo proyecto acabarian llamandose distinto.

        Se filtra por lista blanca y no tachando lo que se sabe malo, porque el
        nombre acaba en una ruta de disco: cualquier `..`, barra o dos puntos que
        sobreviva basta para escribir donde no toca.

        SAME rule as `sanitize_project` in academia_multi_prompt.py, which needs
        it to name the project's .json; change one, change the other or the same
        project's output folder and prompt file end up with different names.
        Allow-list rather than block-list, because the name lands in a disk path.
        """
        if not name:
            return ""
        limpio = "".join(c for c in str(name) if c.isalnum() or c in (" ", "-", "_"))
        return limpio.strip()

    def rutas(self, project_name=""):
        proyecto = self.sanitize_project(project_name)
        # Sin nombre se devuelve el sufijo suelto, que sigue siendo ruta valida.
        # Inventar aqui una carpeta por defecto solo escondaria el campo vacio.
        # With no name the bare suffix comes back -- still a valid path. A default
        # folder here would only hide that the field is empty.
        salidas = tuple("{}/{}".format(proyecto, s) if proyecto else s for s in self.SUFIJOS)
        return (proyecto,) + salidas


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_ProjectPaths": AcademiaProjectPaths
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_ProjectPaths": "Academia SD Project Paths 📁"
}
