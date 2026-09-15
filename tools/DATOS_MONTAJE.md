# Moviola — datos medidos para el montaje de clips encadenados

Todo lo de aquí está **medido**, no estimado. Fecha: 15 sep 2026.
Implementación de referencia: `montar.py`, en esta misma carpeta.

---

## 1. Por qué la latente y no la imagen

El VAE de vídeo de H3 comprime en el tiempo con

```python
FRAME_PER_TOKEN = (1, 4, 4, 4, 4)     # comfy/ldm/minimax/model.py:30
```

Salvo el primero, **cada fotograma latente codifica cuatro fotogramas reales**.
El último latente de un clip no es una imagen fija: lleva dentro la dirección y
la velocidad del movimiento.

Una imagen codificada con `vae.encode()` no lleva nada de eso. Síntoma observado:
un avión que se aleja al final de un clip **retrocede** al principio del
siguiente. El modelo sabe dónde está el sujeto, no hacia dónde iba.

Consecuencia: anclar con la latente guardada, no con `first_frame`.

## 2. Keyframe, no referencia

| estructura | campo | alcance |
|---|---|---|
| `minimax_keyframes` | `resolved_frame_index` | **ancla un fotograma concreto** |
| `minimax_refs` | — | toda la secuencia, sin posición temporal |

Con referencias la identidad se mantiene pero **las tomas no empalman**. Es la
diferencia entre "así es el sujeto" y "empieza aquí".

El keyframe **condiciona, no pega**: se reinyecta en cada paso pero nunca se
denoisa, así que el fotograma 0 se genera *aproximándose* al ancla. Por eso nunca
coincide exactamente y siempre hay algo que corregir en el montaje.

---

## 3. Las tres correcciones del montaje

### 3.1 Recorte del solape

El clip nuevo abre repitiendo el final del anterior.

| `latent_frames` | solape aproximado |
|---:|---|
| 1 | ~4 fotogramas |
| 2 | ~8 fotogramas |

**Cómo localizarlo:** comparar el último fotograma del clip A con los primeros 20
del B y quedarse con el mínimo. El perfil sale en V, con el mínimo inequívoco:

```
union 608->609   22 23 24 21 19 17 14 8 [3] 9 13 15 17 19
union 609->610   30 37 40 42 42 39 33 21 [7] 22 34 42 51 58
```

**El corte va en el mínimo MÁS UNO.** Corregido el 15 sep 2026: el mínimo es el
fotograma que **repite** —el que más se parece al último del clip anterior—, no
dónde cortar. Conservarlo enseña ese instante dos veces y el movimiento se para.

Medido sobre nueve costuras de una serie de diez:

| se corta en | resultado en la costura |
|---|---|
| el mínimo | 7 de 9 cambian **0,18–0,49 ×** el movimiento normal — el parón |
| el mínimo + 1 | 6 de 9 quedan en **1,10–1,21 ×**, que es lo que da un corte |

Un corte cambia algo **más** que un paso normal, nunca menos. Si sale por debajo,
sobra un fotograma.

**Si el perfil sale plano, el mínimo es ruido.** Pasa cuando el plano está casi
quieto: en esa misma serie, ocho costuras dieron su V con movimiento normal de 3
a 21, y la novena salió plana de punta a punta (4,6 a 5,5) con movimiento 1,16.
El rebobinado seguía siendo de ocho fotogramas, solo que no se veía porque no
había nada que se moviera. Como su duración la fija `latent_frames` y no cambia
entre tomas, esa costura copia la mediana de las que sí tienen V.

**Criterio antiguo, de un solo fotograma** (por qué se abandonó):

```
proporcion = |A_ultimo - B_primero| / movimiento_normal
proporcion < 0,6   ->  fotograma repetido, recortar
```

Falla con `latent_frames >= 2`: con 8 fotogramas de rebobinado la proporción sale
alta (2,57) y concluye que no hay que recortar, justo al revés. La búsqueda del
mínimo lo resuelve para cualquier valor.

### 3.2 Exposición

Cada clip se genera por separado y la exposición deriva. Medido hasta **+19,4 de
luminancia** en una costura, subiendo R, G y B casi por igual — firma de cambio
de exposición, no de color.

- **Ganancia por canal, no desplazamiento.** El desajuste es multiplicativo, y un
  offset levantaría los negros del fondo.
- **Medida contra el fotograma que SOBREVIVE al recorte.** Medirla contra el
  fotograma 0 cuando se van a tirar 8 calcula la ganancia de una imagen que se
  descarta: con eso el cambio de tono *sobrevive* a la corrección. Medido, la
  ganancia real pasó de 0,775 a 0,954 al corregir este error.
- **Acumulada** clip a clip. Corrigiendo solo contra el vecino inmediato, una
  deriva lenta y sostenida se cuela entera sin que ninguna costura parezca mala.

Resultado: un salto de +19,4 queda en +0,3.

### 3.3 Audio

Tres problemas distintos, cada uno con su causa.

**No usar `acrossfade`.** Solapa las pistas y **acorta** el resultado: 0,25 s de
desfase por costura. Medido con siete clips, 1,66 s de desincronía; con diez
serían más de dos segundos y el diálogo llega descuadrado.

**Los clips vienen desalineados de origen:** audio 5,120 s contra vídeo 5,145833 s,
**26 ms más corto**. Concatenando sin más, se acumula. Se corrige con `atempo`
(un 0,5%, ~9 centésimos de tono, inaudible), **no** rellenando con silencio —
rellenar deja un agujero a digital cero justo antes de cada costura, medido en
−89,9 dBFS, que es lo que se oye como un corte seco.

**Los clips se desvanecen solos y arrancan con golpe.** Medido en el material:

```
CLIP A, su cola              CLIP B, su arranque
 -175 ms   -19,9 dBFS         +  0 ms   -82,0 dBFS
 - 75 ms   -25,5                + 25 ms   -19,4
 - 24 ms   -33,6                + 50 ms   -12,8
```

Caída de 13,3 dB en la costura si se pegan sin más.

**La solución sale gratis del recorte.** Los fotogramas descartados son un
**rebobinado**, así que su audio cubre el **mismo instante** que la cola del clip
anterior: están temporalmente alineados. Cruzarlos es un `acrossfade` de verdad
**sin desplazar nada**, porque el solape no se inventa, ya estaba ahí.

```
clip B entra N fotogramas antes con rampa de subida
clip A baja en esa misma ventana
```

Medido con una ventana de 8 fotogramas (167 ms a 48 fps): el bache de la costura
sube 6,3 dB y el rango dinámico en ±0,2 s baja de 9,4 a 7,3 dB. Sincronía
intacta: 21 ms constantes con 2, 4 y 7 clips.

**Cuanto mayor el rebobinado, mejor el cruce.** Lo que parecía el precio de dar
más trayectoria al modelo también paga el audio.

**La bajada se hace en la propia pista del clip**, con `afade=t=out:curve=qsin`.
Corregido el 15 sep 2026. La versión anterior sumaba encima una copia de la cola
con `volume=-1.0`, y eso está mal por dos motivos:

- `volume=-1.0` **invierte la fase**, no baja 1 dB. Comprobado: sumar una señal
  con esa copia da −91 dB, silencio digital.
- Restarle a la cola una copia desvanecida deja `cola × (1 − desvanecido)`, que
  es un fundido **de entrada**: el clip saliente se callaba al abrirse la ventana
  y volvía a tope justo en el corte. Al revés de lo que se quiere. Medido, un
  hoyo de 180 ms seguido de un golpe.

`qsin` y no lineal porque las dos mitades del cruce son **dos generaciones del
mismo instante**: se parecen pero no coinciden muestra a muestra, así que un
cruce lineal dejaría unos 3 dB de hoyo en mitad de la ventana.

### 3.4 Audio opcional

`-audio` es una convención del guardador de vídeo, no un hecho: quien no guarde
el proyecto con sonido tendrá `vid_loop_00001.mp4` a secas. Nunca se deduce del
nombre, se le pregunta al fichero — lo que rompe el montaje es referenciar
`[i:a]` de un clip mudo, porque ffmpeg no encuentra el flujo y se cae entero.

Y **o lo tienen todos o no se toca el audio**: con unos cuantos mudos por medio
la pista concatenada duraría menos que la imagen y todo lo posterior al hueco
quedaría descuadrado. Mejor entregarlo mudo y decirlo.

---

## 4. Configuración de generación que funcionó

```
Moviola Guide activo, latent_frames = 2
first_frame desconectado
EasyCache en bypass
12 pasos (turbo LoRA; más no ayuda, está destilado para pocos)
736 x 416, 73 fotogramas
```

## 5. Notas para un futuro nodo

- La medida necesita 4 fotogramas por costura (penúltimo y último de A, primeros
  dos de B) más los ~20 primeros de B para la búsqueda del mínimo.
- Todo en un solo `filter_complex`: encadenar ffmpeg clip a clip recodifica en
  cada paso y la pérdida se acumula.
- `amix` con `normalize=0`. Con `normalize=1`, ffmpeg baja **todo** el montaje
  para hacer sitio a unas ventanas de décimas de segundo.
- Los 21 ms residuales de audio son granularidad del codificador AAC. Son fijos,
  no se acumulan, y equivalen a menos de un fotograma a 48 fps.
