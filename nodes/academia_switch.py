"""Academia Switch nodes.

Toda la logica util de estos dos nodos vive en el frontend (js/academia_switch_*.js):
cambiar el modo de un grupo o reescribir el widget de un loader son cosas del
grafo, no de la ejecucion, igual que en Fast Groups Bypasser. La parte de Python
existe para tres cosas:

  * darle al nodo un widget donde guardar el JSON de la matriz, de modo que se
    serialice con el workflow como cualquier otro valor;
  * exponer el modo activo (nombre e indice) por si quieres encadenarlo a un
    switch de texto, un contador o lo que sea;
  * dejar constancia en la consola de con que modo se ha lanzado la cola.
"""

import json
import sys


def _academiasd_version():
    # El loader del paquete carga cada fichero por ruta, no como submodulo, asi
    # que el import relativo falla y hay que ir a buscar el paquete ya cargado.
    try:
        from .. import __version__ as v
        return v
    except Exception:
        pass
    for name in ("comfyui_AcademiaSD", "comfyui_academiasd", "custom_nodes.comfyui_AcademiaSD"):
        mod = sys.modules.get(name)
        v = getattr(mod, "__version__", None)
        if v:
            return v
    return "?"


ACADEMIASD_VERSION = _academiasd_version()


def _parse(switch_data):
    try:
        data = json.loads(switch_data) if switch_data else {}
    except Exception:
        return {}, [], None
    if not isinstance(data, dict):
        return {}, [], None
    modes = data.get("modes") or []
    if not isinstance(modes, list):
        modes = []
    return data, modes, data.get("active")


def _active(switch_data):
    """Devuelve (nombre, indice) del modo activo. (-1, "") si no hay nada."""
    _data, modes, active_id = _parse(switch_data)
    for i, mode in enumerate(modes):
        if isinstance(mode, dict) and mode.get("id") == active_id:
            return str(mode.get("name", "")), i
    if modes and isinstance(modes[0], dict):
        return str(modes[0].get("name", "")), 0
    return "", -1


class _AcademiaSwitchBase:
    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("mode_name", "mode_index")
    FUNCTION = "run"
    CATEGORY = "AcademiaSD/Switch"

    LABEL = "Switch"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "switch_data": ("STRING", {
                    "default": "{}",
                    "multiline": False,
                    "tooltip": "Serialized state of the switch. Managed by the node UI.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, switch_data="{}", **kwargs):
        # El modo activo forma parte del estado: si cambia, el nodo se re-evalua.
        return switch_data

    def run(self, switch_data="{}", **kwargs):
        name, index = _active(switch_data)
        print(f"[{self.LABEL} v{ACADEMIASD_VERSION}] active mode: "
              f"{name or '(none)'} (#{index})")
        return (name, index)


class AcademiaSwitchGroups(_AcademiaSwitchBase):
    """Matriz Grupos x Modos: un clic cambia el estado de medio workflow."""
    LABEL = "Academia Switch Groups"


class AcademiaSwitchModels(_AcademiaSwitchBase):
    """Mismo juego de modos, pero reescribiendo widgets de otros nodos."""
    LABEL = "Academia Switch Models"


NODE_CLASS_MAPPINGS = {
    "Academia_Switch_Groups": AcademiaSwitchGroups,
    "Academia_Switch_Models": AcademiaSwitchModels,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Academia_Switch_Groups": "Academia Switch · Groups 🎛️",
    "Academia_Switch_Models": "Academia Switch · Models 🧩",
}
