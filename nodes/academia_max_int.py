"""Max Int: el mayor de varios enteros, ignorando los que no esten conectados.

Los switches al uso obligan a elegir UNA rama con un selector, asi que para
quedarse con el mayor de varias fuentes hay que encadenar comparaciones a mano.
Aqui las ocho entradas son opcionales y con `forceInput`, de modo que una entrada
sin cable llega como None y sencillamente no participa: se pueden dejar seis
sueltas y el nodo devuelve el mayor de las dos que si hay.

The usual switches make you pick ONE branch with a selector, so taking the
largest of several sources means chaining comparisons by hand. Here the eight
inputs are optional and `forceInput`, so an unconnected one arrives as None and
simply does not take part: leave six unwired and the node returns the larger of
the two that are.
"""

try:
    from .. import __version__ as ACADEMIASD_VERSION
except Exception:
    ACADEMIASD_VERSION = "2.4.0"

RANURAS = 8


class AcademiaMaxInt:
    @classmethod
    def INPUT_TYPES(cls):
        entradas = {}
        for i in range(1, RANURAS + 1):
            # forceInput hace que sea un puerto y no un widget con valor por
            # defecto. Sin esto una entrada vacia valdria 0 y participaria en la
            # comparacion, que es justo lo que no se quiere.
            # forceInput makes it a socket rather than a widget with a default.
            # Without it an empty input would read as 0 and take part in the
            # comparison, which is exactly what should not happen.
            entradas["in{}".format(i)] = ("INT", {"forceInput": True})
        return {
            "required": {
                "fallback": ("INT", {"default": 0, "min": -2147483648, "max": 2147483647,
                                     "tooltip": "Valor devuelto si no hay ninguna entrada "
                                                "conectada. / Returned when nothing is "
                                                "connected."}),
            },
            "optional": entradas,
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("max_int", "connected")
    FUNCTION = "mayor"
    CATEGORY = "Academia SD/Utilities"

    def mayor(self, fallback=0, **kwargs):
        valores = []
        for i in range(1, RANURAS + 1):
            v = kwargs.get("in{}".format(i))
            if v is None:
                continue
            # Un booleano es un int en Python y se colaria como 0 o 1. Aqui eso
            # seria un valor plausible pero falso, asi que se descarta.
            # A bool is an int in Python and would slip through as 0 or 1 -- a
            # plausible but wrong value here, so it is dropped.
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                continue
            valores.append(int(v))

        if not valores:
            print("[Max Int v{}] ninguna entrada conectada, se devuelve el fallback {} "
                  "/ nothing connected, returning the fallback".format(
                      ACADEMIASD_VERSION, fallback))
            return (int(fallback), 0)

        m = max(valores)
        print("[Max Int v{}] {} de {} / {} out of {}".format(
            ACADEMIASD_VERSION, m, valores, m, valores))
        return (m, len(valores))


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MaxInt": AcademiaMaxInt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MaxInt": "AcademiaSD Max Int",
}
