"""Switch Any: elige una de varias entradas de cualquier tipo.

La entrada elegida es el mayor de los `select` que lleguen; si no llega ninguno,
la 1. Tres `select` en lugar de uno para poder decidir desde varias fuentes sin
cuadrar valores: un select que viene de un nodo en bypass no llega y no cuenta,
asi que un interruptor de grupos puede subir la eleccion a 2 sin que otra rama
tenga que bajarla. Las entradas son lazy: solo se calcula la rama elegida.

The chosen input is the largest `select` that arrives, or 1 when none does.
Three selects instead of one, so several sources can drive the choice without
balancing values: a select coming from a bypassed node does not arrive and does
not count. Inputs are lazy: only the chosen branch is computed.
"""

try:
    from .. import __version__ as ACADEMIASD_VERSION
except Exception:
    ACADEMIASD_VERSION = "2.5.9"

ENTRADAS = 10
SELECTS = ("select_1", "select_2", "select_3")


class _AnyType(str):
    """Tipo comodin: nunca es distinto de nada, asi que enlaza con todo."""

    def __ne__(self, other):
        return False


ANY = _AnyType("*")


def _seleccion(kwargs):
    valores = [int(v) for v in (kwargs.get(s) for s in SELECTS)
               if v is not None and not isinstance(v, bool) and isinstance(v, (int, float))]
    return max(1, max(valores)) if valores else 1


def _entrada(kwargs, pedida):
    """La entrada pedida si esta conectada; si no, la conectada inmediatamente
    inferior (o la primera conectada). None si no hay ninguna."""
    conectadas = sorted(int(k[len("input_"):]) for k in kwargs if k.startswith("input_"))
    if not conectadas:
        return None
    if pedida in conectadas:
        return pedida
    menores = [n for n in conectadas if n < pedida]
    return menores[-1] if menores else conectadas[0]


class AcademiaSwitchAny:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                **{s: ("INT", {"forceInput": True,
                               "tooltip": "The largest select that arrives picks the input; "
                                          "with none, input 1."}) for s in SELECTS},
                **{"input_{}".format(i): (ANY, {"lazy": True}) for i in range(1, ENTRADAS + 1)},
            },
        }

    RETURN_TYPES = (ANY, "INT", "STRING")
    RETURN_NAMES = ("output", "selected", "value_text")
    FUNCTION = "switch"
    CATEGORY = "Academia SD/Utilities"

    def check_lazy_status(self, **kwargs):
        n = _entrada(kwargs, _seleccion(kwargs))
        name = "input_{}".format(n)
        return [name] if n is not None and kwargs.get(name) is None else []

    def switch(self, **kwargs):
        pedida = _seleccion(kwargs)
        n = _entrada(kwargs, pedida)
        if n is None:
            raise ValueError("Switch Any: no input is connected")
        if n != pedida:
            print("[Switch Any v{}] input_{} is not connected, using input_{}".format(
                ACADEMIASD_VERSION, pedida, n))
        valor = kwargs["input_{}".format(n)]
        # El texto, solo para numeros: es para ver en pruebas que valor sale.
        es_numero = isinstance(valor, (int, float)) and not isinstance(valor, bool)
        texto = "{:g}".format(valor) if isinstance(valor, float) else str(valor) if es_numero else ""
        etiqueta = "input_{} → {}".format(n, texto) if texto else "input_{}".format(n)
        return {"ui": {"switch_any": [etiqueta]}, "result": (valor, n, texto)}


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_SwitchAny": AcademiaSwitchAny,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_SwitchAny": "AcademiaSD Switch Any 🔀",
}
