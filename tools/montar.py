# -*- coding: utf-8 -*-
"""Une clips consecutivos de un bucle Moviola, corrigiendo las dos costuras.

Cada toma se genera anclada al ultimo fotograma de la anterior, y el modelo
reproduce ese ancla tan de cerca que el primer fotograma del clip nuevo es casi
identico al ultimo del viejo. Medido: la union cambia entre 4 y 5 veces MENOS que
el movimiento normal del clip, lo que se percibe como un paron de un fotograma.
Tirandolo, la diferencia vuelve al rango normal.

El audio tiene su propia costura, y es la mas audible de las dos: cada clip
arranca el sonido desde muy abajo, asi que al pegar dos seguidos hay una caida
medida de 13,3 dB. Un cruce de 250 ms la deja en 0,3 dB; con 120 ms se queda en
5,5 dB y con 400 o mas vuelve a empeorar.

El video va a CORTE DURO. Solo se cruza el audio: un fundido de video inventaria
fotogramas que el modelo nunca genero, mientras que cruzar el audio es lo que
hace cualquier montador al unir dos tomas.

Joins consecutive clips from a Moviola loop, fixing both seams. Each take is
anchored on the previous take's last frame, and the model reproduces that anchor
so closely that the new clip's first frame is nearly identical to the old one's
last: measured, the seam changes 4-5x LESS than the clip's normal motion, which
reads as a one-frame stall. Dropping it returns the difference to normal.

The audio seam is the more audible of the two: every clip fades its sound up from
near silence, so butting two together gives a measured 13.3 dB drop. A 250 ms
crossfade leaves 0.3 dB. Video stays a hard cut -- a video fade would invent
frames the model never generated, while crossfading audio is ordinary editing.
"""

import argparse
import os
import subprocess
import sys

SALIDA_DIR = r"F:\Claude_temp"
ORIGEN_DIR = r"F:\ComfyUI_windows_portable\ComfyUI\output"
PATRON = "MimiMaxH3_interpolated_{:05d}-audio.mp4"

CRUCE_AUDIO = 0.25          # segundos de desvanecimiento en la cola de cada clip
FPS = 48.0                  # solo de respaldo; los fps reales se leen de cada clip
CRF = 16                    # visualmente indistinguible del original
UMBRAL_RECORTE = 0.6        # por debajo de esto hay fotograma repetido
VENTANA_BUSQUEDA = 20       # cuantos fotogramas del clip nuevo se exploran
HUNDIMIENTO = 0.6           # el minimo debe bajar a esto de los hombros de la V
GANANCIA_COLA = 1.0         # compensa la rampa de entrada del clip siguiente
RAMPA_ENTRADA = 0.08        # MUCHO mas corta que la cola: solo doma el golpe inicial


def _buscar_clip(n):
    """El mp4 de esa vuelta, buscando por su numero y no por un patron de nombre.

    El nombre cambia segun como este montado el flujo: enganchando la salida `path`
    de Moviola Out al guardador, los clips pasan a llamarse como los fotogramas, y
    el guardador ADEMAS anade su propia numeracion detras -- `toma_00001__00001-
    audio.mp4`. Eso deja dos grupos de cinco cifras en el mismo nombre.

    Por eso se exige `_NNNNN_` con guiones bajos a los lados y no la cifra suelta:
    al pedir la vuelta 1, un `00001` suelto tambien casaria con el contador final
    de `toma_00011__00001`, devolviendo el clip de la vuelta 11.

    The clip for that pass, matched by number rather than by a name pattern. The
    name depends on how the workflow is wired: feeding Moviola Out's `path` to the
    saver renames clips after the frames, and the saver ALSO appends its own counter
    -- `toma_00001__00001-audio.mp4` -- leaving two five-digit groups in one name.
    Hence `_NNNNN_` with underscores on both sides rather than the bare digits: for
    pass 1 a loose `00001` would also match the trailing counter of
    `toma_00011__00001` and hand back pass 11's clip.
    """
    import glob
    marca = "{:05d}".format(n)
    todos = glob.glob(os.path.join(ORIGEN_DIR, "**", "*.mp4"), recursive=True)
    estrictos = [f for f in todos if ("_" + marca + "_") in os.path.basename(f)]
    cands = estrictos or [f for f in todos if marca in os.path.basename(f)]
    if not cands:
        return None
    con_audio = [f for f in cands if "audio" in os.path.basename(f).lower()]
    return max(con_audio or cands, key=os.path.getmtime)



def _fps(ruta):
    """Los fps REALES del clip, no un valor fijo.

    La interpolacion se activa y desactiva a voluntad: con ella los clips salen a
    48 fps y sin ella a 24. Con un FPS fijo, el recorte de audio se calcularia con
    el doble o la mitad de duracion por fotograma y desalinearia el sonido justo en
    la costura, que es donde mas se nota.

    The clip's REAL fps. Interpolation gets toggled at will: with it clips are
    48 fps, without it 24. A hardcoded value would compute the audio trim with twice
    or half the per-frame duration and push the sound out of step at the seam.
    """
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", ruta],
                       capture_output=True, text=True)
    try:
        a, b = r.stdout.strip().split("/")
        v = float(a) / float(b)
        return v if v > 1.0 else FPS
    except Exception:
        return FPS



def _duracion(ruta):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", ruta], capture_output=True, text=True)
    return float(r.stdout.strip())


def _duracion_audio(ruta):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
                        "-show_entries", "stream=duration", "-of", "csv=p=0", ruta],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return _duracion(ruta)


def ffmpeg(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y"] + args,
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "ffmpeg fallo")


def _fotograma(ruta, indice, destino):
    """Extrae UN fotograma por su indice exacto. / Extract ONE frame by exact index."""
    ffmpeg(["-i", ruta, "-vf", r"select=eq(n\,{})".format(indice),
            "-vsync", "0", "-frames:v", "1", "-update", "1", destino])


def _n_fotogramas(ruta):
    r = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                        "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", ruta],
                       capture_output=True, text=True)
    return int(r.stdout.strip())


def _dif(a, b):
    from PIL import Image
    import numpy as np
    A = np.asarray(Image.open(a).convert("RGB"), np.float64)
    B = np.asarray(Image.open(b).convert("RGB"), np.float64)
    return float(np.abs(A - B).mean())


def _ganancia(a, b):
    """Cuanto hay que multiplicar el clip SIGUIENTE para igualar al anterior.

    Cada clip se genera por separado, asi que la exposicion se desplaza entre uno
    y otro: medido, hasta +19,4 de luminancia en una costura, subiendo los tres
    canales casi por igual. Eso es etalonaje, no contenido, y se corrige entero.

    Se usa una GANANCIA por canal y no un desplazamiento porque el desajuste es
    multiplicativo -- sube todo el rango, no solo las sombras -- y porque una
    ganancia no puede levantar el negro del fondo, que un offset si haria.

    How much the NEXT clip must be multiplied to match the previous one. Each clip
    is generated independently so exposure drifts between them: measured up to
    +19.4 luminance at one seam, lifting all three channels almost equally. That is
    grade, not content, and it corrects cleanly. A per-channel GAIN is used rather
    than an offset because the mismatch is multiplicative, and because a gain
    cannot lift the blacks the way an offset would.
    """
    from PIL import Image
    import numpy as np
    A = np.asarray(Image.open(a).convert("RGB"), np.float64)
    B = np.asarray(Image.open(b).convert("RGB"), np.float64)
    g = []
    for c in range(3):
        mb = B[..., c].mean()
        g.append(1.0 if mb < 1e-6 else max(0.5, min(2.0, A[..., c].mean() / mb)))
    return g


def _fotogramas(ruta, desde, cuantos, tmp, etq):
    """Varios fotogramas seguidos en UNA llamada a ffmpeg.

    Con veinte fotogramas por costura y nueve costuras, pedirlos de uno en uno
    son casi doscientas aperturas del mismo fichero. / Consecutive frames in ONE
    ffmpeg call: one-at-a-time means ~200 reopenings of the same file.
    """
    patron = os.path.join(tmp, "{}_%03d.png".format(etq))
    ffmpeg(["-i", ruta, "-vf", r"select=gte(n\,{})".format(desde),
            "-vsync", "0", "-frames:v", str(cuantos), patron])
    return [os.path.join(tmp, "{}_{:03d}.png".format(etq, k + 1)) for k in range(cuantos)]


def _perfil(a, b, tmp, etq):
    """Diferencia del ultimo fotograma de A contra los primeros de B.

    El clip nuevo no empieza donde acabo el viejo: empieza ANTES. El ancla es la
    ultima latente, y cada latente salvo la primera codifica cuatro fotogramas
    reales, asi que con `latent_frames = 2` el modelo recibe ocho fotogramas de
    trayectoria y los vuelve a dibujar antes de continuar. El solape no es un
    fotograma repetido: es un rebobinado.

    Comparar solo el fotograma 0 no lo ve. Medido contra los veinte primeros, el
    perfil sale en V y el minimo cae justo donde el rebobinado alcanza al clip
    anterior:

        615->616   24 25 26 24 23 21 18 12 [3] 11 15 17 19
        618->619   29 43 50 52 51 43 33 21 [4] 21 35 45 52

    The new clip does not start where the old one ended: it starts EARLIER. The
    anchor is the last latent and every latent but the first encodes four real
    frames, so with `latent_frames = 2` the model gets eight frames of trajectory
    and redraws them before carrying on. The overlap is a rewind, not a repeated
    frame, and looking only at frame 0 cannot see it.
    """
    na = _n_fotogramas(a)
    fa = _fotogramas(a, na - 2, 2, tmp, etq + "a")
    fb = _fotogramas(b, 0, VENTANA_BUSQUEDA + 1, tmp, etq + "b")
    difs = [_dif(fa[1], x) for x in fb]
    k = min(range(len(difs)), key=lambda i: difs[i])
    mov = (_dif(fa[0], fa[1]) + _dif(fb[k], fb[min(k + 1, len(fb) - 1)])) / 2.0
    # Una V de verdad se hunde muy por debajo de sus dos hombros. Si no lo hace,
    # el perfil es plano y el minimo es ruido -- ver _decidir_recortes.
    hombros = min(difs[0], difs[-1])
    clara = difs[k] < HUNDIMIENTO * hombros
    return {"k": k, "dif": difs[k], "mov": mov, "clara": clara, "fa": fa, "fb": fb}


def _decidir_recortes(perfiles, forzado=None):
    """Cuantos fotogramas quita cada costura.

    El rebobinado dura lo mismo en TODA la serie: lo fija `latent_frames`, que no
    cambia entre tomas. Eso permite rescatar las costuras donde el perfil sale
    plano.

    Sale plano cuando la toma esta casi quieta. Medido en una serie de diez: ocho
    costuras dieron su minimo en 8 con movimiento normal de 3 a 21, y la novena
    salio plana (4,6 a 5,5 de punta a punta) porque el plano apenas se movia, con
    movimiento normal 1,16. Ahi el rebobinado sigue siendo de ocho fotogramas --
    simplemente no se ve, porque no hay nada que se mueva. Preguntarle a esa
    costura donde esta el corte es preguntarselo al ruido; se lo copia a sus
    vecinas, que si lo saben.

    Si NINGUNA costura tiene V, no hay rebobinado que medir y se vuelve al
    criterio antiguo: un solo fotograma si la union cambia mucho menos de lo
    normal, y nada si no.

    The rewind lasts the same across the WHOLE series -- `latent_frames` sets it
    and it does not change between takes -- which is what rescues the seams whose
    profile comes out flat. It comes out flat when the shot is nearly still:
    measured over ten clips, eight seams put their minimum at 8 with normal motion
    of 3 to 21, and the ninth was flat (4.6 to 5.5 end to end) because the shot
    barely moved, normal motion 1.16. The rewind is still eight frames there, it
    just cannot be seen. Asking that seam where the cut is means asking the noise,
    so it copies its neighbours, which do know. With no clear V anywhere there is
    no rewind to measure and the old single-frame rule applies.
    """
    if forzado is not None:
        return [forzado] * len(perfiles)

    claras = [p["k"] for p in perfiles if p["clara"]]
    if not claras:
        return [1 if (p["dif"] / p["mov"] if p["mov"] > 1e-6 else 1.0) < UMBRAL_RECORTE
                else 0 for p in perfiles]

    # El minimo NO es donde hay que cortar: es el fotograma que REPITE. Es el que
    # mas se parece al ultimo del clip anterior, asi que conservarlo enseña ese
    # instante dos veces y el movimiento se para un fotograma. El corte va en el
    # siguiente.
    #
    # Medido sobre nueve costuras: cortando EN el minimo, siete de ellas cambiaban
    # entre 0,18 y 0,49 veces el movimiento normal -- el paron. Cortando un
    # fotograma despues, seis se quedan entre 1,10 y 1,21, que es justo lo que se
    # espera de un corte: un poco mas de cambio que un paso normal, no menos.
    #
    # The minimum is NOT where to cut: it is the frame that REPEATS. It is the one
    # closest to the previous clip's last frame, so keeping it shows that instant
    # twice and the motion stalls. Measured over nine seams: cutting AT the
    # minimum left seven of them changing 0.18-0.49x normal motion -- the stall.
    # Cutting one frame later puts six at 1.10-1.21x, which is what a cut should
    # look like: slightly more change than a normal step, not less.
    claras.sort()
    comun = claras[len(claras) // 2] + 1      # mediana: inmune a una costura rara
    return [p["k"] + 1 if p["clara"] else comun for p in perfiles]


def _medir_costuras(rutas, tmp, forzado=None):
    """Recorte y ganancia de exposicion de cada costura.

    Dos pasadas obligatoriamente: la ganancia se mide contra el fotograma que va a
    SOBREVIVIR al recorte, asi que no se puede calcular hasta saber cuanto se
    recorta. Medirla contra el fotograma 0 cuando se van a tirar ocho calcula la
    ganancia de una imagen que se descarta, y el cambio de tono sobrevive a la
    correccion -- medido, la ganancia real paso de 0,775 a 0,954 al arreglarlo.

    Two passes by necessity: the gain is measured against the frame that SURVIVES
    the trim, so it cannot be computed before the trim is known.
    """
    perfiles = [_perfil(rutas[i], rutas[i + 1], tmp, "s{}".format(i))
                for i in range(len(rutas) - 1)]
    recortes = _decidir_recortes(perfiles, forzado)

    salida = []
    for p, n_rec in zip(perfiles, recortes):
        sup = p["fb"][n_rec] if n_rec < len(p["fb"]) else p["fb"][-1]
        gan = _ganancia(p["fa"][1], sup)
        prop = p["dif"] / p["mov"] if p["mov"] > 1e-6 else 1.0
        salida.append((n_rec, prop, gan, p["clara"], p["k"]))
        for r in p["fa"] + p["fb"]:
            try:
                os.remove(r)
            except OSError:
                pass
    return salida


def main():
    p = argparse.ArgumentParser()
    p.add_argument("primero", type=int, nargs="?")
    p.add_argument("ultimo", type=int, nargs="?")
    p.add_argument("--carpeta", default=None,
                   help="monta TODOS los clips de esa carpeta, por orden de numero "
                        "/ montage every clip in that folder, in number order")
    p.add_argument("-o", "--salida", default=None)
    p.add_argument("--recortar", type=int, default=None,
                   help="fuerza N fotogramas de recorte en cada union "
                        "/ force N frames trimmed at every seam")
    p.add_argument("--crf", type=int, default=CRF,
                   help="calidad de x264; sube el numero para pesar menos "
                        "/ x264 quality; raise it for a smaller file")
    p.add_argument("--sin-igualar", action="store_true",
                   help="no igualar la exposicion entre clips / do not match exposure")
    p.add_argument("--sin-corregir", action="store_true",
                   help="concatenacion cruda, para comparar / raw concat, to compare")
    a = p.parse_args()

    # Con una CARPETA se monta lo que haya dentro, por orden de numero y sin mas
    # preguntas. Es lo que hace falta al descartar una toma del medio: el hueco
    # que deja no es un fallo, es la seleccion, y abortar por el seria estorbar.
    # Ademas acota la busqueda, que recorriendo `output` entero compite con
    # cientos de mp4 ajenos.
    #
    # A FOLDER montages whatever is inside, in number order, no questions asked --
    # which is what you want after discarding a take from the middle, since the gap
    # it leaves is the selection, not a fault. It also bounds the search, which
    # over all of `output` competes with hundreds of unrelated mp4s.
    if a.carpeta:
        import glob, re
        hallados = []
        for f in glob.glob(os.path.join(a.carpeta, "*.mp4")):
            cifras = re.findall(r"(\d{4,6})", os.path.basename(f))
            if cifras:
                hallados.append((int(cifras[-1]), f))
        hallados.sort()
        numeros = [n for n, _ in hallados]
        rutas = [f for _, f in hallados]
        if not rutas:
            print("\n  No hay ningun mp4 en {}\n".format(a.carpeta))
            return 1
    else:
        if a.primero is None or a.ultimo is None:
            print("\n  Hacen falta dos numeros de clip, o --carpeta.\n")
            return 1
        if a.ultimo < a.primero:
            a.primero, a.ultimo = a.ultimo, a.primero
        numeros = list(range(a.primero, a.ultimo + 1))

        # Se comprueban TODOS antes de empezar: mejor no hacer nada que entregar
        # un montaje al que le falta un clip por el medio sin avisar.
        # Every clip is checked before starting: better to do nothing than hand
        # over a cut with a clip silently missing from the middle.
        rutas, faltan = [], []
        for n in numeros:
            r = _buscar_clip(n)
            (rutas if r else faltan).append(r if r else n)
        if faltan:
            print("\n  No existen estos clips: {}".format(
                ", ".join(str(x) for x in faltan)))
            print("  Buscados por su numero en: {}\n".format(ORIGEN_DIR))
            return 1
    if len(rutas) < 2:
        print("\n  Hacen falta al menos dos clips para que haya una union.\n")
        return 1

    destino = a.salida or os.path.join(
        SALIDA_DIR, "montaje_{:05d}_{:05d}{}.mp4".format(
            numeros[0], numeros[-1], "_crudo" if a.sin_corregir else ""))
    os.makedirs(os.path.dirname(destino) or ".", exist_ok=True)

    print("\n  {} clips: {} -> {}".format(len(rutas), numeros[0], numeros[-1]))

    if a.sin_corregir:
        lista = os.path.join(SALIDA_DIR, "_lista.txt")
        with open(lista, "w", encoding="utf-8") as f:
            for r in rutas:
                f.write("file '{}'\n".format(r.replace("\\", "/")))
        ffmpeg(["-f", "concat", "-safe", "0", "-i", lista, "-c", "copy", destino])
        os.remove(lista)
        print("  concatenacion cruda, sin recodificar")
    else:
        # Todo en un solo filter_complex: encadenar ffmpeg por clips obligaria a
        # recodificar en cada paso, y la perdida se acumularia con cada union.
        # One filter_complex for everything: chaining ffmpeg per clip would
        # re-encode at every step, and the loss would pile up per seam.
        import tempfile
        tmp = tempfile.mkdtemp(prefix="moviola_")
        try:
            dec = _medir_costuras(rutas, tmp, a.recortar)
        finally:
            try:
                os.rmdir(tmp)
            except OSError:
                pass
        print()
        igualar = not a.sin_igualar
        for k, (rec, prop, g, clara, kmin) in enumerate(dec):
            print("   union {} -> {}   minimo en {:>2}{}   ganancia {:.3f}/{:.3f}/{:.3f}   {}".format(
                numeros[k], numeros[k + 1], kmin,
                "   " if clara else " (?)",
                g[0], g[1], g[2],
                "recorta {}".format(rec) if rec else "empalma ya"))
        print()
        # recorta[i]: si el clip i entra sin su primer fotograma
        recorta = [0] + [d[0] for d in dec]

        # La correccion de exposicion se ACUMULA: cada clip se iguala al anterior,
        # que a su vez ya viene igualado al suyo. Corrigiendo solo contra el vecino
        # inmediato, una deriva lenta y sostenida se colaria entera a lo largo del
        # montaje sin que ninguna costura pareciera mala por separado.
        #
        # The exposure correction ACCUMULATES: each clip is matched to the previous
        # one, which is itself already matched. Correcting only against the
        # immediate neighbour would let a slow steady drift through across the whole
        # cut, with no single seam ever looking wrong.
        gan = [[1.0, 1.0, 1.0]]
        for d in dec:
            gan.append([gan[-1][c] * d[2][c] for c in range(3)])

        entradas, filtros, vs = [], [], []
        for i, r in enumerate(rutas):
            entradas += ["-i", r]
            sel = r"select=gte(n\,{}),".format(recorta[i]) if recorta[i] else ""
            g = gan[i]
            col = "" if (not igualar or max(abs(x - 1.0) for x in g) < 0.005) else                   "colorchannelmixer=rr={:.4f}:gg={:.4f}:bb={:.4f},".format(g[0], g[1], g[2])
            filtros.append("[{i}:v]{s}{c}setpts=PTS-STARTPTS[v{i}]".format(i=i, s=sel, c=col))
            vs.append("[v{}]".format(i))
        filtros.append("{}concat=n={}:v=1:a=0[v]".format("".join(vs), len(rutas)))

        # NO se usa acrossfade: SOLAPA las dos pistas, asi que cada union adelanta
        # el audio posterior y el desfase se acumula -- medido, 0,25 s por costura,
        # mas de dos segundos al cabo de diez clips, con el dialogo descuadrado.
        #
        # En su lugar se desvanece la COLA de cada clip. Como el siguiente ya
        # arranca casi en silencio (-33 dBFS medidos), basta con que el anterior
        # baje a su encuentro. Sin solape, la duracion no cambia y video y audio
        # siguen alineados hasta el final.
        #
        # acrossfade is NOT used: it OVERLAPS the two streams, so every seam pulls
        # the later audio earlier and the drift accumulates -- measured at 0.25 s
        # per seam, over two seconds across ten clips, with the dialogue visibly
        # out of sync. Instead each clip's TAIL is faded out. Since the next one
        # already starts near silence (-33 dBFS measured), the previous one only
        # has to come down to meet it. With no overlap the duration is unchanged
        # and picture and sound stay locked.
        # TRES problemas distintos en la costura de audio, y cada uno necesita lo
        # suyo:
        #
        # 1. acrossfade NO sirve: solapa las pistas y ACORTA el resultado, asi que
        #    cada union adelanta el audio posterior. Medido, 0,25 s por costura y
        #    mas de dos segundos al cabo de diez clips, con el dialogo descuadrado.
        #
        # 2. Los clips salen del generador con el audio ~26 ms MAS CORTO que el
        #    video (5,120 s frente a 5,145833 s). Concatenando sin mas, ese hueco
        #    se acumula. Cada pista se rellena a la duracion exacta de su video.
        #
        # 3. Desvanecer la cola sin mas deja un BACHE: el ambiente baja a silencio
        #    y el clip siguiente tarda medio segundo en levantarlo. Por eso la cola
        #    no se desvanece en su sitio, sino que se DUPLICA y se superpone sobre
        #    el arranque del clip siguiente, decayendo. La linea de tiempo no se
        #    toca -- las colas se mezclan ENCIMA -- asi que el ambiente cruza la
        #    costura sin hueco y sin desfase.
        #
        # Three separate problems at the audio seam. acrossfade is wrong because it
        # SHORTENS the result, pulling later audio earlier, 0.25 s per seam. The
        # clips arrive with audio ~26 ms shorter than video, which accumulates
        # unless each track is padded to its video's exact length. And simply
        # fading the tail leaves a HOLE, since the next clip takes half a second to
        # bring its room tone up. So the tail is DUPLICATED and mixed OVER the next
        # clip's opening instead, decaying: the timeline is untouched, the ambience
        # carries across, and nothing drifts.
        # CRUCE DE VERDAD, SIN DESFASE, usando lo que el recorte descarta.
        #
        # Al recortar N fotogramas del clip siguiente se tira tambien su audio. Pero
        # esos fotogramas son un REBOBINADO: cubren el mismo instante que la cola del
        # clip anterior. O sea que ese audio descartado y esa cola son dos versiones
        # del MISMO momento, ya alineadas en el tiempo.
        #
        # Asi que en vez de tirarlo, el clip siguiente entra N fotogramas ANTES con
        # una rampa de subida, y el anterior baja en esa misma ventana. Se cruzan de
        # verdad -- como acrossfade -- pero sin acortar nada, porque el solape no se
        # inventa: estaba ahi. Sin recorte no hay ventana y se vuelve al corte seco.
        #
        # A REAL CROSSFADE WITH NO DRIFT, out of what the trim throws away. Trimming
        # N frames off the next clip discards its audio too -- but those frames are a
        # REWIND, covering the same instant as the previous clip's tail. That
        # discarded audio and that tail are two takes of the SAME moment, already
        # aligned. So instead of dropping it, the next clip comes in N frames EARLY
        # with a fade-up while the previous one fades down across the same window.
        # They genuinely cross, like acrossfade, without shortening anything, because
        # the overlap is not invented: it was already there.
        # La bajada del clip anterior se hace SOBRE SU PROPIA pista, no anadiendo
        # encima una copia invertida. Restar una copia desvanecida de la cola a la
        # cola misma deja `cola x (1 - desvanecido)`, que es un fundido de ENTRADA:
        # el clip anterior se calla al empezar la ventana y vuelve a tope justo en
        # el corte, al reves de lo que se quiere. Medido, el resultado era un hoyo
        # de 180 ms seguido de un golpe. (`volume=-1.0` invierte la fase de verdad:
        # sumar una senal con esa copia da -91 dB, silencio digital.)
        #
        # The previous clip comes down ON ITS OWN track rather than by adding an
        # inverted copy on top. Subtracting a faded copy of the tail from the tail
        # leaves `tail x (1 - fadeout)`, which is a fade IN: the outgoing clip goes
        # silent as the window opens and returns to full exactly at the cut, the
        # wrong way round. (`volume=-1.0` really does invert: summing a signal with
        # that copy gives -91 dB.)
        cortes = [1.0 / _fps(r) for r in rutas]        # por clip, no global
        ventanas = [cortes[i] * recorta[i] for i in range(len(rutas))]

        aes, colas, inicio = [], [], 0.0
        for i, r in enumerate(rutas):
            corte = cortes[i]
            n_rec = recorta[i]
            dur = _duracion(r) - corte * n_rec                    # duracion de VIDEO
            dur_a = _duracion_audio(r) - corte * n_rec
            tempo = max(0.5, min(2.0, dur_a / dur)) if dur > 0 else 1.0
            pre = ("[{i}:a]".format(i=i) if not n_rec else
                   "[{i}:a]atrim=start={t},asetpts=PTS-STARTPTS,".format(i=i, t=corte * n_rec))

            # curve=qsin (potencia constante). Las dos mitades del cruce son dos
            # generaciones del mismo instante: se parecen, pero no coinciden
            # muestra a muestra, asi que un cruce lineal dejaria un hoyo de 3 dB en
            # mitad de la ventana.
            # qsin (constant power): the two halves of the crossfade are two
            # generations of the same instant -- alike but not sample-identical --
            # so a linear cross would dip ~3 dB mid-window.
            v_sal = ventanas[i + 1] if i + 1 < len(rutas) else 0.0
            baja = ("" if v_sal <= 0.005 else
                    ",afade=t=out:st={st}:d={v}:curve=qsin".format(st=dur - v_sal, v=v_sal))
            filtros.append(
                "{p}atempo={t:.9f},apad,atrim=0:{d},asetpts=PTS-STARTPTS{b}[fa{i}]".format(
                    p=pre, t=tempo, d=dur, b=baja, i=i))
            aes.append("[fa{}]".format(i))

            ventana = ventanas[i]
            if i > 0 and ventana > 0.005:
                # la parte descartada, subiendo, colocada sobre la cola anterior
                # the discarded head, fading up, laid over the previous tail
                filtros.append(
                    "[{i}:a]atrim=0:{v},asetpts=PTS-STARTPTS,"
                    "afade=t=in:st=0:d={v}:curve=qsin,"
                    "adelay={ms}|{ms}[cr{i}]".format(
                        i=i, v=ventana, ms=int(round((inicio - ventana) * 1000))))
                colas.append("[cr{}]".format(i))
            inicio += dur

        filtros.append("{}concat=n={}:v=0:a=1[abase]".format("".join(aes), len(rutas)))
        if colas:
            # normalize=0: sumar sin atenuar. Con normalize=1 ffmpeg bajaria TODO el
            # montaje para hacer sitio a unas ventanas de decimas de segundo.
            # normalize=0: sum without attenuating. normalize=1 would duck the WHOLE
            # cut to make room for windows lasting tenths of a second.
            filtros.append("[abase]{}amix=inputs={}:normalize=0:dropout_transition=0[a]".format(
                "".join(colas), len(colas) + 1))
        else:
            filtros.append("[abase]anull[a]")

        ffmpeg(entradas + ["-filter_complex", ";".join(filtros),
                           "-map", "[v]", "-map", "[a]",
                           "-c:v", "libx264", "-crf", str(a.crf), "-preset", "medium",
                           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                           destino])
        print("  {} union(es), {} recortada(s), exposicion {}, audio {:.0f} ms".format(
            len(dec), sum(1 for x in recorta[1:] if x),
            "igualada" if igualar else "sin tocar", CRUCE_AUDIO * 1000))

    mb = os.path.getsize(destino) / 1048576.0
    print("\n  -> {}  ({:.1f} MB)\n".format(destino, mb))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print("\n  ERROR de ffmpeg:\n  {}\n".format(exc))
        sys.exit(1)
