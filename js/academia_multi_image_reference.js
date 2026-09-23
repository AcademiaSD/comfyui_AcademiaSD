import { app } from "../../scripts/app.js";

// Vale para cualquier modelo que coma varias imagenes de referencia; Qwen Image
// 2.1 es solo el primero. Por eso ni el nodo ni este fichero llevan su nombre.
const NODE_NAMES = ["AcademiaSD_MultiImageReference", "AcademiaSD_QwenRefImages"];

const SLOTS = 10;         // los que maneja Qwen Image 2.1
const COLS = 3;           // la grande y tres filas de tres: 1 + 9
const HERO = 0;           // la ranura 1, en indice 0

// Alturas en unidades de GRAFO, calculadas, nunca medidas del DOM. ComfyUI
// dimensiona los widgets DOM en pixeles de PANTALLA mientras node.size va en
// unidades de grafo: a zoom 2.3 una fila de 26 px mide 60, y realimentar esa
// medida hace crecer el nodo sin parar. El layout lo define este fichero
// entero, asi que su altura se puede sumar en vez de preguntarla.
const H = {
    pad: 8,
    gap: 4,
    head: 24,
    bar: 16,        // la barra del rotulo, ENCIMA de la miniatura
    heroBar: 20,    // la del hero es mas alta: el rotulo va a 11 px
    chip: 24,       // ranura vacia: un cuadradito y ya
    // Una ranura CARGADA no mide una constante: las tres filas se reparten el
    // alto de la imagen 1, y asi las dos columnas acaban a la vez y no queda
    // medio panel vacio cuando la grande esta alta.
    heroCap: 24,    // pie de dos lineas
    slider: 12,     // ancho del carril
    sliderGap: 3,
    // Largo FIJO a proposito. Si el carril midiera lo que mide la caja que el
    // mismo controla, se realimenta: cuanto mas pequena la haces, mas corto es
    // su recorrido y mas rapido corre el tirador. Imposible de ajustar.
    sliderLen: 132,
    grip: 18,       // alto del tirador dentro del carril
};

// Limites del recuadro de la imagen 1. Los dos carriles se mueven aqui dentro.
// El recuadro de la imagen 1 SIEMPRE tiene la proporcion de lo que ensena.
// El carril fija el tamano y el otro lado sale solo: dos medidas sueltas
// permitirian deformar la zona de trabajo, y entonces lo que ves no es lo que
// va a salir. Los topes son anchos para que la proporcion casi nunca tope.
const HERO_W = { min: 80, max: 560 };
const HERO_H = { min: 80, max: 560, def: 240 };
const PLACE = { min: 0.02, max: 8 };        // los mismos topes que en Python

const COL_MIN = 96;       // por debajo, "<image12>" y sus botones no caben
const BASE_W = 548;

const GREEN = "#2d9444";
const RED = "#8c3030";

// Copia literal de comfy/utils.py::common_upscale con crop = "center". El
// recuadro tiene que decir lo que va a pasar DE VERDAD con la imagen, asi que
// no vale calcularlo "parecido": misma cuenta o no sirve de nada.
function cropBox(ow, oh, tw, th, crop) {
    if (crop !== "center" || !tw || !th) return { x: 0, y: 0, w: ow, h: oh };
    const oldA = ow / oh, newA = tw / th;
    let x = 0, y = 0;
    if (oldA > newA) x = Math.round((ow - ow * (newA / oldA)) / 2);
    else if (oldA < newA) y = Math.round((oh - oh * (oldA / newA)) / 2);
    return { x, y, w: ow - x * 2, h: oh - y * 2 };
}

// La misma ventana que el modo center -- la mayor que cubre el destino sin
// deformar -- pero colocada donde se haya arrastrado. Copia de lo que hace
// Python en _resize(crop="custom"): si no, el recuadro miente.
function customWindow(ow, oh, tw, th, cx, cy) {
    const oldA = ow / oh, newA = tw / th;
    let kw = ow, kh = oh;
    if (oldA > newA) kw = Math.max(1, Math.round(ow * (newA / oldA)));
    else if (oldA < newA) kh = Math.max(1, Math.round(oh * (oldA / newA)));
    const x = Math.min(ow - kw, Math.max(0, Math.round(cx * ow - kw / 2)));
    const y = Math.min(oh - kh, Math.max(0, Math.round(cy * oh - kh / 2)));
    return { x, y, w: kw, h: kh };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
const clampF = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};

// "white" / "#abc" / "abcdef" -> "#aabbcc", que es lo unico que traga un
// <input type="color"> y tambien vale como color de CSS.
const NAMED = { white: "ffffff", black: "000000", grey: "808080", gray: "808080" };
function cssColor(text) {
    let t = String(text ?? "").trim().toLowerCase().replace(/^#/, "");
    t = NAMED[t] ?? t;
    if (t.length === 3) t = t.split("").map(c => c + c).join("");
    return /^[0-9a-f]{6}$/.test(t) ? `#${t}` : "#ffffff";
}

// Un fichero de input/ puede venir como "subcarpeta/nombre.png".
function viewURL(file, ver) {
    const cut = String(file).lastIndexOf("/");
    const sub = cut >= 0 ? file.slice(0, cut) : "";
    const name = cut >= 0 ? file.slice(cut + 1) : file;
    // `ver` sube solo cuando esa ranura cambia de fichero. Poner aqui un
    // Date.now() volveria a descargar las doce miniaturas en cada repintado, y
    // hay un repintado por cada clic en el nodo.
    return `/view?filename=${encodeURIComponent(name)}&type=input`
         + `&subfolder=${encodeURIComponent(sub)}&v=${ver || 0}`;
}

async function uploadImage(file) {
    const body = new FormData();
    body.append("image", file);
    body.append("overwrite", "false");   // nunca pisar algo que ya este en input/
    const resp = await fetch("/upload/image", { method: "POST", body });
    if (resp.status !== 200) throw new Error(`${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

app.registerExtension({
    name: "AcademiaSD.MultiImageReference",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_NAMES.includes(nodeData.name)) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);
            const self = this;

            /* --- estado --- */

            // `ver` no se guarda: solo sirve para que el navegador no reutilice
            // la miniatura anterior cuando una ranura cambia de fichero.
            // nw y nh son el tamano real del fichero. Se recuerdan porque la
            // proporcion de la zona de trabajo sale de ahi: sin ellos, cada vez
            // que se rehace la tarjeta hay un frame en que naturalWidth aun no
            // existe, la caja adivina otra forma y se ve el estiron.
            self.asdSlots = Array.from({ length: SLOTS },
                () => ({ file: "", on: false, ver: 0, nw: 0, nh: 0 }));
            self.asdCards = {};      // los elementos vivos de cada ranura
            self.asdGridEls = {};    // la celda de cada ranura
            self.asdRowEls = [];     // la caja de cada fila
            self.asdOpen = true;
            self.asdHeroH = HERO_H.def;      // la unica medida que se guarda
            // Centro de la imagen dentro del lienzo, en fracciones, y su escala
            // relativa a "entra entera". Se pone arrastrando, no escribiendo,
            // asi que vive aqui y no en un widget.
            self.asdPlace = { x: 0.5, y: 0.5, scale: 1 };
            // Centro de la ventana de recorte sobre la imagen, modo custom.
            self.asdCropPos = { x: 0.5, y: 0.5 };

            // Lo que otro nodo puede preguntarle a este. Resolution Calc lo usa
            // en "Get Size from Image": cada salida sirve un fichero distinto,
            // asi que hay que decir cual segun por donde salga el cable.
            self.asdRefFileForOutput = (slotIndex) => self.asdSlots?.[slotIndex]?.file || null;
            // La de la ranura 1, que es la que fija el lienzo. Resolution Calc
            // la pide mirando hacia delante, sin necesidad de un cable de vuelta.
            self.asdPrimaryRefFile = () => self.asdSlots?.[HERO]?.file || null;

            // Lo que usa Image Save & Send para devolver aqui una imagen recien
            // generada y poder seguir iterando sobre ella. Por defecto entra en
            // la ranura 1, que es la que fija el lienzo. Devuelve true si la ha
            // aceptado, para que quien la mande sepa si tiene que buscar otra via.
            self.asdReceiveImage = (path, slotIndex) => {
                const i = Number.isInteger(slotIndex) ? slotIndex : HERO;
                const slot = self.asdSlots?.[i];
                if (!slot || !path) return false;
                slot.file = String(path);
                slot.on = true;      // te la mandan para usarla
                slot.ver++;          // que el navegador no reutilice la miniatura vieja
                slot.nw = slot.nh = 0;   // otra imagen, otro tamano
                commit();
                return true;
            };

            const dataW = this.widgets.find(w => w.name === "refs_data");
            if (dataW) {
                // La visibilidad la decide `hidden`, no `type`: marcando solo
                // type = "hidden" el widget sigue en el layout y ComfyUI le
                // sigue creando su wrapper sobre el canvas, que traga clics.
                dataW.hidden = true;
                dataW.type = "hidden";
                dataW.computeSize = () => [0, 0];   // nunca negativo
            }

            const readState = () => {
                if (!dataW) return;
                try {
                    const parsed = JSON.parse(dataW.value || "{}");
                    const slots = Array.isArray(parsed.slots) ? parsed.slots : [];
                    // El tamano medido se conserva SOLO si la ranura sigue con el
                    // mismo fichero, asi que hay que mirar el anterior antes de
                    // machacarlo.
                    const prev = self.asdSlots || [];
                    self.asdSlots = Array.from({ length: SLOTS }, (_, i) => {
                        const file = String(slots[i]?.file || "");
                        const same = file && prev[i]?.file === file;
                        return {
                            file,
                            on: !!slots[i]?.on,
                            ver: 0,
                            nw: same ? (prev[i].nw || 0) : 0,
                            nh: same ? (prev[i].nh || 0) : 0,
                        };
                    });
                    if (typeof parsed.open === "boolean") self.asdOpen = parsed.open;
                    if (parsed.heroH) self.asdHeroH = clamp(parsed.heroH, HERO_H.min, HERO_H.max);
                    const cp = parsed.cropPos;
                    if (cp && typeof cp === "object") {
                        self.asdCropPos = { x: clampF(cp.x ?? 0.5, 0, 1), y: clampF(cp.y ?? 0.5, 0, 1) };
                    }
                    const pl = parsed.place;
                    if (pl && typeof pl === "object") {
                        self.asdPlace = {
                            x: clampF(pl.x ?? 0.5, -3, 4),
                            y: clampF(pl.y ?? 0.5, -3, 4),
                            scale: clampF(pl.scale ?? 1, PLACE.min, PLACE.max),
                        };
                    }
                } catch (e) { /* JSON roto: se queda el estado vacio de arriba */ }
            };

            const writeState = () => {
                if (!dataW) return;
                dataW.value = JSON.stringify({
                    open: self.asdOpen,
                    heroH: self.asdHeroH,
                    place: self.asdPlace,
                    cropPos: self.asdCropPos,
                    slots: self.asdSlots.map(s => ({ file: s.file, on: s.on })),
                });
            };

            const isActive = (s) => !!(s.on && s.file);

            // La etiqueta que el encoder va a usar DE VERDAD. Qwen numera las
            // <imageN> por la posicion en la lista ya compactada (descarta los
            // None), asi que apagar la ranura 1 convierte la 2 en <image1>.
            // Poner aqui el numero de ranura seria mentir en cuanto se apaga
            // una de en medio. Ver comfy/text_encoders/qwen_image21.py.
            const liveTags = () => {
                const tags = new Array(SLOTS).fill(null);
                let n = 0;
                for (let i = 0; i < SLOTS; i++) if (isActive(self.asdSlots[i])) tags[i] = ++n;
                return tags;
            };

            // Una ranura cuya salida no va a ninguna parte no pinta nada en
            // pantalla: cargar ahi una imagen no la usaria nadie. Se ensenan las
            // cableadas, y las que ya tengan fichero aunque se les quite el
            // cable, que si no una imagen cargada desapareceria sin avisar.
            const visibleSlots = () => {
                const out = [];
                for (let i = 1; i < SLOTS; i++) {
                    const wired = (self.outputs?.[i]?.links?.length || 0) > 0;
                    if (wired || self.asdSlots[i].file) out.push(i);
                }
                return out;
            };

            /* --- medidas --- */

            // Lo que se ensena: rellenando, el LIENZO de destino; recortando, la
            // imagen. La zona de trabajo toma esa proporcion y asi nada se
            // deforma ni hace falta pedirle a CSS que cuadre nada.
            const heroAspect = () => {
                const t = targetSize();
                const im = self.asdHero?.img;
                const sl = self.asdSlots[HERO];
                const nw = im?.naturalWidth || sl.nw, nh = im?.naturalHeight || sl.nh;
                const srcA = (nw && nh) ? nw / nh : 0;
                if (cropMode() === "pad" && Array.isArray(t)) return t[0] / t[1];
                if (srcA) return srcA;
                if (Array.isArray(t)) return t[0] / t[1];
                return 1;
            };

            // Caja interior (la foto) en unidades de grafo. +2 del borde.
            const heroBox = () => {
                const a = Math.min(12, Math.max(1 / 12, heroAspect()));
                let h = clamp(self.asdHeroH, HERO_H.min, HERO_H.max);
                let w = Math.round(h * a);
                if (w > HERO_W.max) { w = HERO_W.max; h = Math.round(w / a); }
                if (w < HERO_W.min) { w = HERO_W.min; h = Math.round(w / a); }
                return { w, h: Math.max(40, h) };
            };

            const heroCardH = () => H.heroBar + heroBox().h + H.heroCap + 2;
            const gridRows = () => {
                const vis = visibleSlots(), rows = [];
                for (let i = 0; i < vis.length; i += COLS) rows.push(vis.slice(i, i + COLS));
                return rows;
            };

            // Las filas vacias se quedan cerradas y ocupan su tira de 22 px. Lo
            // que sobra del alto de la grande se lo reparten a partes iguales
            // las filas que tengan alguna imagen: con solo la 2 puesta, su fila
            // se queda a un pelo de la grande en vez de en un triste tercio.
            const rowHeights = () => {
                const rows = gridRows();
                const filled = rows.map(r => r.some(k => self.asdSlots[k].file));
                const n = filled.filter(Boolean).length;
                if (!n) return filled.map(() => H.chip);
                const gaps = Math.max(0, rows.length - 1) * H.gap;
                const spare = heroCardH() - gaps - (rows.length - n) * H.chip;
                const each = Math.max(38, Math.floor(spare / n));
                return filled.map(f => (f ? each : H.chip));
            };
            const heroColH = () => Math.max(heroCardH(), H.sliderLen);
            const heroColW = () => heroBox().w + 2 + H.sliderGap + H.slider;
            // La rejilla no puede quedar por debajo de tres columnas legibles
            // solo porque el recuadro de la imagen 1 haya crecido.
            const minWidth = () => Math.max(BASE_W, heroColW() + COL_MIN * COLS + 30);

            const panelHeight = () => {
                if (!self.asdOpen) return H.head;
                const hs = rowHeights();
                const grid = hs.reduce((a, b) => a + b, 0) + Math.max(0, hs.length - 1) * H.gap;
                return H.head + H.gap + Math.max(grid, heroColH()) + H.pad;
            };

            /* --- DOM --- */

            const container = document.createElement("div");
            container.style.cssText = `
                position: relative;
                width: 100%; height: 100%; box-sizing: border-box; overflow: hidden;
                display: flex; flex-direction: column; gap: 4px;
                font-family: sans-serif; color: #ddd;
            `;
            container.innerHTML = `
                <style>
                    .asd-q-head {
                        display: flex; align-items: center; gap: 6px; flex: 0 0 auto;
                        height: 20px; padding: 0 6px; background: #1d1d1d;
                        border: 1px solid #383838; border-radius: 4px;
                        font-size: 10px; letter-spacing: .5px; color: #9aa0a6;
                        cursor: pointer; user-select: none;
                    }
                    .asd-q-head:hover { border-color: #4a6ee0; }
                    .asd-q-count { margin-left: auto; color: #6f7883; font-variant-numeric: tabular-nums; }
                    .asd-q-body { display: flex; gap: 6px; flex: 1 1 auto; min-height: 0; }
                    /* Filas flex y no CSS grid: una plantilla de columnas es la
                       misma para todas las filas, y aqui cada fila reparte su
                       ancho segun lo que tenga puesto ella. */
                    .asd-q-grid {
                        flex: 1 1 auto; display: flex; flex-direction: column;
                        gap: 4px; min-width: 0; align-content: start;
                    }
                    .asd-q-row { display: flex; gap: 4px; min-width: 0; align-items: stretch; }
                    /* Lo que esta en uso se reparte el hueco; lo que no, se cierra
                       a un cuadradito y deja de estorbar. Igual que con el alto. */
                    .asd-q-row > .asd-q-card { flex: 1 1 0; min-width: 0; height: 100%; }
                    .asd-q-row > .asd-q-chip {
                        flex: 0 0 auto; width: ${H.chip}px; align-self: flex-start;
                    }
                    .asd-q-hero { display: flex; gap: 3px; flex: 0 0 auto; align-items: flex-start; }
                    .asd-q-empty {
                        display: flex; align-items: center;
                        justify-content: center; height: ${H.chip - 4}px;
                        color: #5f6570; font-size: 9px; font-style: italic;
                    }

                    /* Una ranura vacia es una tira fina: no ocupa sitio hasta que se usa */
                    .asd-q-chip {
                        height: ${H.chip}px; box-sizing: border-box;
                        display: flex; align-items: center; justify-content: center; gap: 4px;
                        border: 1px dashed #3d3d3d; border-radius: 4px; background: #161616;
                        color: #5f6570; font-size: 10px; cursor: pointer;
                        transition: border-color .12s, color .12s;
                    }
                    .asd-q-chip:hover, .asd-q-chip.drop { border-color: #4a6ee0; color: #9aa0a6; background: #1b2033; }

                    /* Dos piezas: el rotulo va ENCIMA de la miniatura, no flotando
                       sobre ella. En una celda de tres columnas no hay sitio para
                       que "<image12>" y sus botones compartan la misma esquina. */
                    .asd-q-card {
                        position: relative;
                        display: flex; flex-direction: column; box-sizing: border-box;
                        overflow: hidden; border: 1px solid #444; border-radius: 4px;
                        background: #141414;
                    }
                    .asd-q-card.drop { border-color: #4a6ee0 !important; }

                    /* Completas, nunca recortadas: una referencia hay que verla
                       entera para saber si es la que toca. La caja toma la
                       proporcion real del fichero, asi que el recuadro de recorte
                       se puede colocar en porcentajes y sale bien a cualquier zoom. */
                    .asd-q-shot {
                        flex: 1 1 auto; min-height: 0; background: #0b0b0b;
                        display: flex; align-items: center; justify-content: center;
                        cursor: zoom-in; overflow: hidden;
                    }
                    /* La miniatura no necesita caja con proporcion: contain la
                       ensena entera y no hay forma de que se deforme. */
                    .asd-q-shot > img { object-fit: contain; }
                    /* Sin aspect-ratio a proposito: la proporcion la pone .asd-q-shot,
                       que se dimensiona desde JS. Pedirsela a CSS con un lado ya
                       definido hacia que max-height recortara sin encoger el otro
                       lado, y la imagen salia aplastada. */
                    .asd-q-fit { position: relative; overflow: hidden; width: 100%; height: 100%; }
                    .asd-q-place { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
                    .asd-q-card img { width: 100%; height: 100%; display: block; pointer-events: none; }
                    .asd-q-card.off img { filter: grayscale(1) brightness(.42); }
                    .asd-q-crop {
                        position: absolute; box-sizing: border-box;
                        border: 1px solid #fff; pointer-events: none;
                        /* Una sola caja: el reborde enorme oscurece todo lo que
                           queda fuera, y el overflow del padre lo recorta. */
                        box-shadow: 0 0 0 9999px rgba(0, 0, 0, .5);
                    }
                    /* Rellenando, fuera del recuadro esta el color de relleno de
                       verdad: taparlo de negro seria mentir sobre el color. */
                    .asd-q-crop.nodim {
                        /* Un borde blanco sobre relleno blanco no se ve: se le deja
                           un halo oscuro de 1 px para que lea sobre cualquier color. */
                        box-shadow: 0 0 0 1px rgba(0, 0, 0, .55);
                    }
                    /* Solo se puede coger cuando hay algo que mover. */
                    .asd-q-crop.drag { pointer-events: auto; cursor: move; }
                    .asd-q-handle {
                        position: absolute; right: -4px; bottom: -4px;
                        width: 9px; height: 9px; box-sizing: border-box;
                        background: #fff; border: 1px solid #333; border-radius: 2px;
                        cursor: nwse-resize;
                    }
                    .asd-q-swatch {
                        width: 16px; height: 14px; padding: 0; flex: 0 0 auto;
                        border: 1px solid #4a4a4a; border-radius: 3px;
                        background: #242424; cursor: pointer;
                    }

                    .asd-q-bar {
                        flex: 0 0 auto; height: ${H.bar}px; display: flex; align-items: center;
                        gap: 3px; padding: 0 2px 0 4px; background: #1b1b1b;
                        border-bottom: 1px solid #2c2c2c;
                    }
                    .asd-q-tag {
                        font-family: monospace; font-size: 9px; font-weight: bold; color: #fff;
                        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                        pointer-events: none;
                    }
                    .asd-q-tag.muted { color: #7b828c; font-weight: normal; }
                    .asd-q-btns { margin-left: auto; display: flex; gap: 2px; flex: 0 0 auto; }
                    .asd-q-btn {
                        width: 14px; height: 14px; line-height: 12px; text-align: center;
                        border: 1px solid #4a4a4a; border-radius: 3px; background: #242424;
                        color: #ccc; font-size: 8px; cursor: pointer; padding: 0;
                    }
                    .asd-q-btn:hover { border-color: #999; background: #333; }
                    .asd-q-btn.on  { background: ${GREEN}; border-color: ${GREEN}; color: #fff; }
                    .asd-q-btn.off { background: ${RED}; border-color: ${RED}; color: #fff; }

                    .asd-q-name {
                        flex: 0 0 auto; padding: 1px 4px; background: #1b1b1b; color: #99a0a8;
                        font-size: 9px; white-space: nowrap; overflow: hidden;
                        text-overflow: ellipsis; border-top: 1px solid #2c2c2c;
                        pointer-events: none;
                    }
                    /* Dos lineas: "1295x1135 -> 1536x1376" y cuanto se recorta no
                       caben seguidas, y cortar justo la cifra del recorte deja el
                       pie diciendo nada. */
                    .asd-q-name.hero {
                        height: ${H.heroCap}px; white-space: pre-line; line-height: 11px;
                        text-overflow: clip; font-variant-numeric: tabular-nums;
                    }

                    /* Los dos carriles que dimensionan el recuadro de la imagen 1 */
                    /* Carril propio y no <input type="range"> vertical: en vertical
                       Chromium lo pinta con su estilo nativo, ignora el tirador que
                       le pongas y ademas -webkit-appearance: slider-vertical esta
                       obsoleto. Se le escapaba el circulo fuera del carril. */
                    .asd-q-rail {
                        position: relative; flex: 0 0 auto;
                        width: ${H.slider}px; border-radius: ${H.slider / 2}px;
                        background: #2b2b2b; cursor: ns-resize;
                    }
                    .asd-q-grip {
                        position: absolute; left: 1px; right: 1px; height: ${H.grip}px;
                        border-radius: 3px; background: #6f7883; pointer-events: none;
                        transition: background .12s;
                    }
                    .asd-q-rail:hover .asd-q-grip, .asd-q-rail.activo .asd-q-grip { background: #4a6ee0; }

                    /* Consultar una referencia en grande, encima de todo el panel */
                    .asd-q-lightbox {
                        position: absolute; inset: 0; z-index: 9;
                        background: rgba(0, 0, 0, .92); cursor: zoom-out;
                        display: flex; flex-direction: column; align-items: center;
                        justify-content: center; gap: 4px; padding: 6px;
                        box-sizing: border-box; border-radius: 4px;
                    }
                    .asd-q-lightbox img {
                        max-width: 100%; min-height: 0; flex: 1 1 auto;
                        object-fit: contain; display: block;
                    }
                    .asd-q-lbcap {
                        flex: 0 0 auto; font-size: 10px; color: #b9bec6;
                        font-family: monospace; white-space: nowrap;
                        overflow: hidden; text-overflow: ellipsis; max-width: 100%;
                    }
                </style>
                <div class="asd-q-head">
                    <span>&#128444;&#65039; MULTI IMAGE REFERENCE</span>
                    <span class="asd-q-count"></span>
                    <span class="asd-q-chevron">&#9662;</span>
                </div>
                <div class="asd-q-body">
                    <div class="asd-q-grid"></div>
                    <div class="asd-q-hero">
                        <div class="asd-q-herocard" style="display:flex"></div>
                        <div class="asd-q-rail asd-q-vh"
                             title="Drag: size of the image 1 box (it keeps its shape)">
                            <div class="asd-q-grip"></div>
                        </div>
                    </div>
                </div>
                <input type="file" class="asd-q-file" accept="image/*" style="display:none">
            `;

            const head = container.querySelector(".asd-q-head");
            const countEl = container.querySelector(".asd-q-count");
            const chevron = container.querySelector(".asd-q-chevron");
            const body = container.querySelector(".asd-q-body");
            const grid = container.querySelector(".asd-q-grid");
            const heroCol = container.querySelector(".asd-q-hero");
            const heroCard = container.querySelector(".asd-q-herocard");
            const rail = container.querySelector(".asd-q-vh");
            const grip = container.querySelector(".asd-q-grip");
            const filePick = container.querySelector(".asd-q-file");

            /* --- carga de ficheros --- */

            let pickTarget = -1;
            filePick.addEventListener("change", async () => {
                const file = filePick.files?.[0];
                filePick.value = "";                 // volver a elegir el mismo fichero debe disparar change
                if (file && pickTarget >= 0) await putFile(pickTarget, file);
            });

            const openPicker = (idx) => { pickTarget = idx; filePick.click(); };

            const putFile = async (idx, file) => {
                try {
                    const name = await uploadImage(file);
                    const slot = self.asdSlots[idx];
                    slot.file = name;
                    slot.on = true;                  // cargar una imagen es querer usarla
                    slot.ver++;
                    commit();
                } catch (e) {
                    console.error("[MultiImageReference] upload failed:", e);
                    countEl.textContent = "upload failed";
                    countEl.style.color = "#d29922";
                }
            };

            const clearSlot = (idx) => {
                const slot = self.asdSlots[idx];
                slot.file = "";
                slot.on = false;
                slot.ver++;
                commit();
            };

            const toggleSlot = (idx) => {
                const slot = self.asdSlots[idx];
                if (!slot.file) { openPicker(idx); return; }   // nada que encender todavia
                slot.on = !slot.on;
                writeState();
                refreshChrome();
            };

            // Arrastrar y soltar. Hay que cortar el evento aqui: ComfyUI escucha
            // el drop en el canvas y crearia un Load Image suelto al lado.
            const dropTarget = (el, idx) => {
                el.addEventListener("dragover", (e) => {
                    e.preventDefault(); e.stopPropagation();
                    e.dataTransfer.dropEffect = "copy";
                    el.classList.add("drop");
                });
                el.addEventListener("dragleave", () => el.classList.remove("drop"));
                el.addEventListener("drop", async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    el.classList.remove("drop");
                    const file = e.dataTransfer?.files?.[0];
                    if (file && file.type.startsWith("image/")) await putFile(idx, file);
                });
            };

            /* --- consultar una referencia en grande --- */

            const lightbox = document.createElement("div");
            lightbox.className = "asd-q-lightbox";
            lightbox.style.display = "none";
            const lbImg = document.createElement("img");
            const lbCap = document.createElement("div");
            lbCap.className = "asd-q-lbcap";
            lightbox.appendChild(lbImg);
            lightbox.appendChild(lbCap);
            lightbox.addEventListener("click", (e) => {
                e.stopPropagation();
                lightbox.style.display = "none";
            });
            container.appendChild(lightbox);

            const openLightbox = (idx) => {
                const slot = self.asdSlots[idx];
                if (!slot.file) return;
                lbImg.src = viewURL(slot.file, slot.ver);
                lbCap.textContent = `slot ${idx + 1} · ${slot.file}`;
                lightbox.style.display = "flex";
            };

            // El recuadro de la imagen 1 presta su sitio mientras el raton esta
            // sobre otra ranura. Las miniaturas ya estan descargadas, asi que la
            // misma URL sale de la cache y no cuesta una peticion por tarjeta;
            // los 120 ms son solo para que barrer la rejilla no parpadee.
            let peekTimer = null;
            const peek = document.createElement("div");
            peek.style.cssText = `
                position: absolute; inset: 0; z-index: 3; display: none;
                background: #0b0b0b; align-items: center; justify-content: center;
            `;
            const peekImg = document.createElement("img");
            peekImg.style.cssText = "max-width:100%; max-height:100%; object-fit:contain; width:auto; height:auto;";
            const peekTag = document.createElement("div");
            peekTag.style.cssText = `
                position: absolute; left: 0; bottom: 0; padding: 1px 5px;
                background: rgba(0,0,0,.8); color: #cfd4da; font-size: 9px;
                font-family: monospace; pointer-events: none;
            `;
            peek.appendChild(peekImg);
            peek.appendChild(peekTag);

            const showPeek = (idx) => {
                clearTimeout(peekTimer);
                peekTimer = setTimeout(() => {
                    const slot = self.asdSlots[idx];
                    if (!slot.file || !self.asdHeroCardEl) return;
                    peekImg.src = viewURL(slot.file, slot.ver);
                    peekTag.textContent = `slot ${idx + 1}`;
                    self.asdHeroCardEl.appendChild(peek);
                    peek.style.display = "flex";
                }, 120);
            };
            const hidePeek = () => {
                clearTimeout(peekTimer);
                peek.style.display = "none";
            };

            /* --- tamano de salida de la imagen 1 --- */

            // Si width/height llegan por cable, el frontend no conoce su valor:
            // nadie ha ejecutado nada todavia. Se salta un eslabon y se lee el
            // widget del nodo de origen que se llame como la salida ("WIDTH" ->
            // widget "width"), que es justo lo que Resolution Calc mantiene al
            // dia. Si no se puede averiguar se devuelve null y el recuadro NO se
            // dibuja: mas vale no ensenar nada que ensenar un encuadre falso.
            const resolveSize = (name) => {
                const inp = self.inputs?.find(i => i.widget?.name === name);
                if (inp?.link != null) {
                    const link = app.graph?.links?.[inp.link];
                    const origin = link ? app.graph.getNodeById(link.origin_id) : null;
                    const outName = origin?.outputs?.[link.origin_slot]?.name || "";
                    const w = origin?.widgets?.find(
                        x => String(x.name).toLowerCase() === String(outName).toLowerCase());
                    const v = Math.round(Number(w?.value));
                    return Number.isFinite(v) && v > 0 ? v : null;
                }
                const v = Math.round(Number(self.widgets?.find(x => x.name === name)?.value));
                return Number.isFinite(v) && v > 0 ? v : 0;      // 0 = no reescalar
            };

            // null = no se puede saber · 0 = sin reescalado · [w, h] = destino
            const targetSize = () => {
                const w = resolveSize("width"), h = resolveSize("height");
                if (w === null || h === null) return null;
                return (w && h) ? [w, h] : 0;
            };

            const cropMode = () => self.widgets?.find(x => x.name === "crop")?.value || "center";
            const padColor = () => cssColor(self.widgets?.find(x => x.name === "pad_color")?.value);
            const outpaintOn = () => !!self.widgets?.find(x => x.name === "outpaint")?.value;

            const setRect = (el, l, t, w, h) => {
                el.style.left = `${l}%`;
                el.style.top = `${t}%`;
                el.style.width = `${w}%`;
                el.style.height = `${h}%`;
            };

            // Donde cae la imagen dentro del lienzo, en fracciones de 0..1.
            // La MISMA cuenta que hace Python, que si no el recuadro miente.
            const padLayout = (ow, oh, tw, th) => {
                const out = outpaintOn();
                const px = out ? self.asdPlace.x : 0.5;
                const py = out ? self.asdPlace.y : 0.5;
                const ps = out ? self.asdPlace.scale : 1;
                const f = Math.min(tw / ow, th / oh);
                const dw = ow * f * ps, dh = oh * f * ps;
                return { l: (px * tw - dw / 2) / tw, t: (py * th - dh / 2) / th,
                         w: dw / tw, h: dh / th, ps };
            };

            const paintHero = () => {
                const hero = self.asdHero;
                const slot = self.asdSlots[HERO];
                if (!hero || !hero.img || !slot.file) return;

                const ow = hero.img.naturalWidth || slot.nw;
                const oh = hero.img.naturalHeight || slot.nh;
                if (!ow || !oh) return;                     // aun sin cargar

                const t = targetSize();
                const mode = cropMode();
                const pad = mode === "pad";
                const out = pad && outpaintOn();
                let line1 = `${ow}\u00d7${oh}`;
                let line2;

                hero.handle.style.display = out ? "" : "none";
                // Arrastrable colocando la imagen (outpaint) o eligiendo el
                // recorte (custom). En center no hay nada que mover.
                hero.crop.classList.toggle("drag", !!dragKind());
                if (self.asdSwatch) {
                    self.asdSwatch.style.display = pad ? "" : "none";
                    self.asdSwatch.value = padColor();
                }
                if (self.asdHome) self.asdHome.style.display = dragKind() ? "" : "none";

                if (t === null || t === 0) {
                    // Sin destino no hay nada que encuadrar: la imagen y ya.
                    hero.shot.style.background = "#0b0b0b";
                    setRect(hero.place, 0, 0, 100, 100);
                    hero.crop.style.display = "none";
                    line2 = t === null ? "size is linked \u2014 queue once" : "no resize";
                } else if (!pad) {
                    const [tw, th] = t;
                    const custom = mode === "custom";
                    hero.shot.style.background = "#0b0b0b";
                    setRect(hero.place, 0, 0, 100, 100);
                    const box = custom
                        ? customWindow(ow, oh, tw, th, self.asdCropPos.x, self.asdCropPos.y)
                        : cropBox(ow, oh, tw, th, mode);
                    hero.crop.style.display = "";
                    hero.crop.classList.remove("nodim");
                    setRect(hero.crop, box.x / ow * 100, box.y / oh * 100,
                            box.w / ow * 100, box.h / oh * 100);
                    line1 += ` \u2192 ${tw}\u00d7${th}`;
                    if (custom) {
                        // La ventana ya no esta centrada, asi que "2x N" no
                        // describiria nada: se dice lo que se queda.
                        line2 = `keeps ${box.w}\u00d7${box.h} px \u00b7 drag to move`;
                    } else if (box.x > 0) line2 = `trims 2\u00d7${box.x} px sideways`;
                    else if (box.y > 0) line2 = `trims 2\u00d7${box.y} px top/bottom`;
                    else line2 = "nothing trimmed";
                } else {
                    // pad: ahora lo que se ve es el LIENZO de destino, con su
                    // color de relleno, y la imagen colocada dentro.
                    const [tw, th] = t;
                    const L = padLayout(ow, oh, tw, th);
                    hero.shot.style.background = padColor();
                    setRect(hero.place, L.l * 100, L.t * 100, L.w * 100, L.h * 100);
                    hero.crop.style.display = "";
                    // Sin oscurecer: fuera del recuadro esta el color de relleno
                    // de verdad, y taparlo con un 50% de negro seria mentir sobre
                    // el color que se ha elegido.
                    hero.crop.classList.add("nodim");
                    setRect(hero.crop, L.l * 100, L.t * 100, L.w * 100, L.h * 100);
                    line1 += ` \u2192 ${tw}\u00d7${th}`;
                    line2 = out ? `outpaint \u00b7 ${Math.round(L.ps * 100)}% \u00b7 drag to place`
                                : "padded \u00b7 nothing lost";
                }
                hero.cap.textContent = `${line1}\n${line2}`;
                hero.cap.title = `${slot.file}\n${line1} \u00b7 ${line2}`;
            };

            /* --- colocar la imagen a mano (outpaint) --- */

            let persistTimer = null;
            const persistPlace = () => {
                clearTimeout(persistTimer);
                persistTimer = setTimeout(() => { writeState(); }, 180);
            };

            const resetPlace = () => {
                self.asdPlace = { x: 0.5, y: 0.5, scale: 1 };
                self.asdCropPos = { x: 0.5, y: 0.5 };
                paintHero();
                writeState();
            };

            // Arrastrar mueve; la esquina y la rueda escalan. Todo en fracciones
            // del lienzo, medidas sobre la caja: asi da igual el zoom del grafo.
            // "place" = colocar la imagen dentro del lienzo (outpaint)
            // "crop"  = mover la ventana de recorte sobre la imagen (custom)
            const dragKind = () => {
                const mode = cropMode();
                if (mode === "custom") return "crop";
                if (mode === "pad" && outpaintOn()) return "place";
                return null;
            };

            const startDrag = (e, kind) => {
                const dk = dragKind();
                if (!dk) return;
                if (kind === "scale" && dk !== "place") return;   // recortando no se escala
                e.preventDefault(); e.stopPropagation();
                const hero = self.asdHero;
                const rect = hero.fit.getBoundingClientRect();
                if (!rect.width || !rect.height) return;

                const desde = { ...self.asdCropPos };
                const from = { ...self.asdPlace };
                const cx = rect.left + from.x * rect.width;
                const cy = rect.top + from.y * rect.height;
                const d0 = Math.max(4, Math.hypot(e.clientX - cx, e.clientY - cy));

                self.asdDragged = false;
                const move = (ev) => {
                    if (Math.abs(ev.clientX - e.clientX) > 2 || Math.abs(ev.clientY - e.clientY) > 2) {
                        self.asdDragged = true;
                    }
                    if (dk === "crop") {
                        // La caja ensena la imagen entera, asi que un pixel de
                        // raton es una fraccion directa del ancho de la imagen.
                        self.asdCropPos.x = clampF(desde.x + (ev.clientX - e.clientX) / rect.width, 0, 1);
                        self.asdCropPos.y = clampF(desde.y + (ev.clientY - e.clientY) / rect.height, 0, 1);
                        paintHero();
                        return;
                    }
                    if (kind === "move") {
                        self.asdPlace.x = clampF(from.x + (ev.clientX - e.clientX) / rect.width, -3, 4);
                        self.asdPlace.y = clampF(from.y + (ev.clientY - e.clientY) / rect.height, -3, 4);
                    } else {
                        const d1 = Math.hypot(ev.clientX - cx, ev.clientY - cy);
                        self.asdPlace.scale = clampF(from.scale * (d1 / d0), PLACE.min, PLACE.max);
                    }
                    paintHero();
                };
                const up = () => {
                    window.removeEventListener("mousemove", move);
                    window.removeEventListener("mouseup", up);
                    writeState();
                };
                window.addEventListener("mousemove", move);
                window.addEventListener("mouseup", up);
            };

            // Repintar SOLO cuando algo haya cambiado de verdad. Se guardan tres
            // primitivas sueltas en vez de una cadena: compararlas no asigna
            // memoria, asi que esto sale gratis aunque se llame a menudo.
            let lastW = -1, lastH = -1, lastCrop = "", lastPad = "", lastOut = null;
            const syncIfChanged = () => {
                const t = targetSize();
                const tw = t === null ? -2 : (t === 0 ? 0 : t[0]);
                const th = t === null ? -2 : (t === 0 ? 0 : t[1]);
                const cm = cropMode(), pc = padColor(), op = outpaintOn();
                if (tw === lastW && th === lastH && cm === lastCrop
                    && pc === lastPad && op === lastOut) return;
                lastW = tw; lastH = th; lastCrop = cm; lastPad = pc; lastOut = op;
                // Cambiar el destino cambia la proporcion de la zona de trabajo,
                // asi que hay que rehacer la caja y el alto del nodo, no solo
                // volver a pintar dentro.
                applyHeroBox();
                paintHero();
                fit_();
            };

            /* --- pintado --- */

            const makeCard = (idx, tag, big) => {
                const slot = self.asdSlots[idx];
                const on = isActive(slot);

                if (!slot.file) {
                    const chip = document.createElement("div");
                    chip.className = "asd-q-chip";
                    if (big) {
                        chip.style.flex = "1";
                        chip.style.flexDirection = "column";
                        chip.style.gap = "2px";
                        chip.style.height = "auto";
                        chip.innerHTML = `<div style="font-size:11px;color:#7d848e;">&#43; image 1</div>
                                          <div style="font-size:9px;">drop or click</div>`;
                    } else {
                        // En un cuadrado de 24 px no cabe mas que esto.
                        chip.style.fontSize = "9px";
                        chip.innerHTML = `<span>&#43;${idx + 1}</span>`;
                    }
                    chip.title = `Slot ${idx + 1} - click to browse, or drop an image here`;
                    chip.addEventListener("click", (e) => { e.stopPropagation(); openPicker(idx); });
                    dropTarget(chip, idx);
                    return chip;
                }

                const card = document.createElement("div");
                card.className = "asd-q-card" + (on ? "" : " off");
                if (big) card.style.minWidth = "0";   // el alto lo ponen applyHeroBox
                                                      // y applyGridHeights
                card.style.borderColor = on ? GREEN : RED;

                const bar = document.createElement("div");
                bar.className = "asd-q-bar";
                if (big) bar.style.height = `${H.heroBar}px`;

                const tagEl = document.createElement("div");
                tagEl.className = "asd-q-tag" + (on ? "" : " muted");
                // Apagada no tiene etiqueta que ensenar, porque no llega al
                // encoder: se pone el numero de ranura para saber cual es.
                tagEl.textContent = on ? `<image${tag}>` : `${idx + 1} off`;
                if (big) tagEl.style.fontSize = "11px";
                bar.appendChild(tagEl);

                const btns = document.createElement("div");
                btns.className = "asd-q-btns";
                const mk = (html, title, cls, fn) => {
                    const b = document.createElement("button");
                    b.className = "asd-q-btn" + (cls ? " " + cls : "");
                    b.innerHTML = html;
                    b.title = title;
                    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
                    return b;
                };
                const power = mk("&#9211;", on ? "Active - click to bypass this slot"
                                              : "Bypassed - click to activate",
                                 on ? "on" : "off", () => toggleSlot(idx));
                btns.appendChild(power);
                // Reemplazar tiene boton propio porque el clic sobre la imagen
                // pasa a ser "verla en grande", que es lo que se hace a menudo.
                btns.appendChild(mk("&#8635;", "Replace this image", "", () => openPicker(idx)));
                btns.appendChild(mk("&#10005;", "Unload this slot", "", () => clearSlot(idx)));
                if (big) {
                    // El color solo pinta rellenando, y recentrar solo con el
                    // outpaint encendido: fuera de eso serian dos botones que no
                    // hacen nada.
                    const sw = document.createElement("input");
                    sw.type = "color";
                    sw.className = "asd-q-swatch";
                    sw.title = "Fill colour for the padding";
                    sw.value = padColor();
                    sw.style.display = cropMode() === "pad" ? "" : "none";
                    sw.addEventListener("mousedown", (e) => e.stopPropagation());
                    sw.addEventListener("input", (e) => {
                        e.stopPropagation();
                        const w = self.widgets?.find(x => x.name === "pad_color");
                        if (w) w.value = sw.value.toUpperCase();
                        paintHero();
                        app.graph?.setDirtyCanvas(true, true);
                    });
                    btns.insertBefore(sw, btns.firstChild);
                    self.asdSwatch = sw;

                    const home = mk("&#8982;", "Recentre and fit the image", "", resetPlace);
                    home.style.display = dragKind() ? "" : "none";
                    btns.insertBefore(home, btns.firstChild);
                    self.asdHome = home;
                }
                bar.appendChild(btns);
                card.appendChild(bar);

                const shot = document.createElement("div");
                shot.className = "asd-q-shot";
                const img = document.createElement("img");
                img.src = viewURL(slot.file, slot.ver);
                // NADA de loading="lazy". Son miniaturas locales, no ahorra nada, y
                // paintHero no puede pintar el recuadro hasta que la imagen haya
                // cargado: si el navegador decide que el panel no se ve -- al
                // abrir un workflow, o recreando los <img> en un render -- el
                // evento load no llega nunca y el outpaint se queda muerto.

                let fit = null, place = null;
                if (big) {
                    // Solo el hero necesita caja colocable: es donde se arrastra.
                    fit = document.createElement("div");
                    fit.className = "asd-q-fit";
                    place = document.createElement("div");
                    place.className = "asd-q-place";
                    place.appendChild(img);
                    fit.appendChild(place);
                    shot.appendChild(fit);
                } else {
                    shot.appendChild(img);
                    img.addEventListener("load", () => {
                        if (img.naturalWidth) { slot.nw = img.naturalWidth; slot.nh = img.naturalHeight; }
                    });
                }
                card.appendChild(shot);

                // naturalWidth no existe hasta que la imagen carga, y de ella sale
                // la proporcion de la zona de trabajo.
                if (big) {
                    const onLoad = () => {
                        if (img.naturalWidth) { slot.nw = img.naturalWidth; slot.nh = img.naturalHeight; }
                        applyHeroBox(); paintHero(); fit_();
                    };
                    img.addEventListener("load", onLoad);
                    img.addEventListener("error", () => {
                        console.warn("[MultiImageReference] no se pudo cargar", slot.file);
                    });
                    if (img.complete) onLoad();
                    // decode() resuelve tambien cuando el load ya paso de largo.
                    img.decode?.().then(onLoad).catch(() => {});
                }

                shot.addEventListener("click", (e) => {
                    e.stopPropagation();
                    // Soltar despues de arrastrar tambien dispara un click. Abrir
                    // ahi la vista grande deja sin saber si estas editando o
                    // mirando, que es justo lo desconcertante.
                    if (self.asdDragged) { self.asdDragged = false; return; }
                    openLightbox(idx);
                });
                shot.title = "Click to see it large";

                if (big) {
                    const cropEl = document.createElement("div");
                    cropEl.className = "asd-q-crop";
                    cropEl.style.display = "none";
                    const handle = document.createElement("div");
                    handle.className = "asd-q-handle";
                    handle.style.display = "none";
                    handle.title = "Drag to resize";
                    cropEl.appendChild(handle);
                    fit.appendChild(cropEl);

                    cropEl.addEventListener("mousedown", (e) => startDrag(e, "move"));
                    handle.addEventListener("mousedown", (e) => startDrag(e, "scale"));
                    cropEl.addEventListener("wheel", (e) => {
                        if (dragKind() !== "place") return;
                        // Sin esto la rueda se la queda el lienzo del grafo y
                        // acabas alejando el zoom en vez de escalar la imagen.
                        e.preventDefault(); e.stopPropagation();
                        self.asdPlace.scale = clampF(
                            self.asdPlace.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06),
                            PLACE.min, PLACE.max);
                        paintHero();
                        persistPlace();
                    }, { passive: false });

                    const cap = document.createElement("div");
                    cap.className = "asd-q-name hero";
                    cap.textContent = slot.file;
                    card.appendChild(cap);

                    self.asdHero = { img, fit, place, shot, crop: cropEl, handle, cap };
                } else {
                    card.addEventListener("mouseenter", () => showPeek(idx));
                    card.addEventListener("mouseleave", hidePeek);
                }

                dropTarget(card, idx);
                self.asdCards[idx] = { card, tag: tagEl, power };
                return card;
            };

            // El tamano se escribe en pixeles porque dentro del widget DOM una
            // unidad de grafo es un pixel de CSS. Calcularlo aqui evita el
            // aspect-ratio de CSS, que con un lado ya definido recorta por
            // max-height sin encoger el otro: por ahi es por donde salia la
            // imagen aplastada.
            // Se aplica sobre los elementos que ya estan puestos, asi que sirve
            // igual al pintar que al arrastrar el carril.
            const applyGridHeights = () => {
                const hs = rowHeights();
                self.asdRowEls.forEach((el, r) => {
                    if (el) el.style.height = `${hs[r]}px`;
                });
            };

            const applyHeroBox = () => {
                const b = heroBox();
                const cardH = H.heroBar + b.h + H.heroCap + 2;
                heroCol.style.width = `${b.w + 2 + H.sliderGap + H.slider}px`;
                heroCol.style.height = `${Math.max(cardH, H.sliderLen)}px`;
                rail.style.height = `${H.sliderLen}px`;
                // Medidas fijas por las dos puntas: con flex-grow suelto, un
                // desajuste de dos pixeles se lo come la foto y la proporcion
                // deja de ser exacta.
                const card = self.asdHeroCardEl;
                if (card) {
                    card.style.flex = "0 0 auto";
                    card.style.width = `${b.w + 2}px`;
                    card.style.height = `${H.heroBar + b.h + H.heroCap + 2}px`;
                }
                if (self.asdHero?.shot) {
                    self.asdHero.shot.style.flex = "0 0 auto";
                    self.asdHero.shot.style.height = `${b.h}px`;
                }
                applyGridHeights();
                // Arriba = mas grande, que es lo que espera la mano.
                const f = (b.h - HERO_H.min) / (HERO_H.max - HERO_H.min);
                grip.style.top = `${Math.round((1 - clampF(f, 0, 1)) * (H.sliderLen - H.grip))}px`;
                return b;
            };

            const updateCount = (tags, hidden) => {
                const active = tags.filter(t => t !== null).length;
                const loaded = self.asdSlots.filter(s => s.file).length;
                countEl.style.color = "#6f7883";
                countEl.textContent = `${active} active / ${loaded} loaded`
                                    + (hidden ? `  ·  ${hidden} unwired` : "");
                countEl.title = hidden
                    ? `${hidden} slots are hidden because their outputs go nowhere.\n`
                    + "Connect image_N to show slot N."
                    : "";
            };

            // Encender o apagar no cambia el tamano ni que ranuras se ven: solo
            // el color, el rotulo y la numeracion. Rehacer la tarjeta crearia un
            // <img> nuevo, y ese frame en que todavia no esta decodificado es el
            // parpadeo. Aqui se toca lo justo, sobre los elementos que ya estan.
            const refreshChrome = () => {
                const tags = liveTags();
                for (let i = 0; i < SLOTS; i++) {
                    const ref = self.asdCards[i];
                    if (!ref) continue;
                    const on = isActive(self.asdSlots[i]);
                    ref.card.classList.toggle("off", !on);
                    ref.card.style.borderColor = on ? GREEN : RED;
                    ref.tag.className = "asd-q-tag" + (on ? "" : " muted");
                    ref.tag.textContent = on ? `<image${tags[i]}>` : `${i + 1} off`;
                    ref.power.className = "asd-q-btn " + (on ? "on" : "off");
                    ref.power.title = on ? "Active - click to bypass this slot"
                                         : "Bypassed - click to activate";
                }
                updateCount(tags, (SLOTS - 1) - visibleSlots().length);
                app.graph?.setDirtyCanvas(true, true);
            };

            const render = () => {
                self.asdCards = {};
                self.asdGridEls = {};
                self.asdRowEls = [];
                const tags = liveTags();
                const vis = visibleSlots();
                updateCount(tags, (SLOTS - 1) - vis.length);
                chevron.innerHTML = self.asdOpen ? "&#9662;" : "&#9656;";
                body.style.display = self.asdOpen ? "flex" : "none";
                lightbox.style.display = "none";
                hidePeek();
                if (!self.asdOpen) return;


                grid.replaceChildren();
                if (!vis.length) {
                    const note = document.createElement("div");
                    note.className = "asd-q-empty";
                    note.textContent = "connect image_2 … image_10 to open more slots";
                    grid.appendChild(note);
                } else {
                    gridRows().forEach((row, r) => {
                        const rowEl = document.createElement("div");
                        rowEl.className = "asd-q-row";
                        for (const i of row) {
                            const el = makeCard(i, tags[i], false);
                            self.asdGridEls[i] = el;
                            rowEl.appendChild(el);
                        }
                        self.asdRowEls[r] = rowEl;
                        grid.appendChild(rowEl);
                    });
                }
                applyGridHeights();

                const heroEl = makeCard(HERO, tags[HERO], true);
                heroCard.replaceChildren(heroEl);
                self.asdHeroCardEl = heroEl;
                applyHeroBox();
            };

            // Un solo sitio por el que pasa cualquier cambio: guarda, repinta y
            // ajusta la altura del nodo.
            const commit = () => {
                writeState();
                render();
                fit_();
            };

            head.addEventListener("click", (e) => {
                e.stopPropagation();
                self.asdOpen = !self.asdOpen;
                commit();
            });

            // Mientras se arrastra el carril solo se toca el CSS; el estado y el
            // tamano del nodo se guardan al soltar, para no reescribir el widget
            // ni llamar a setSize en cada pixel del recorrido.
            // Los dos carriles son el MISMO ajuste visto por sus dos lados: el
            // vertical da el alto, el horizontal el ancho, y el que no tocas se
            // recoloca solo. La zona de trabajo crece y mengua, nunca se deforma.
            // Se mide el carril en pantalla y se trabaja en FRACCIONES suyas: asi
            // da igual el zoom del grafo, que escala el panel entero.
            const tallaDesdeCarril = (clientY) => {
                const r = rail.getBoundingClientRect();
                if (!r.height) return;
                const fg = H.grip / H.sliderLen;                  // lo que ocupa el tirador
                let p = ((clientY - r.top) / r.height - fg / 2) / (1 - fg);
                p = clampF(p, 0, 1);
                self.asdHeroH = clamp(HERO_H.max - p * (HERO_H.max - HERO_H.min),
                                      HERO_H.min, HERO_H.max);
                applyHeroBox();
            };

            rail.addEventListener("mousedown", (e) => {
                e.preventDefault(); e.stopPropagation();
                rail.classList.add("activo");
                tallaDesdeCarril(e.clientY);           // saltar a donde se ha pinchado
                const mover = (ev) => tallaDesdeCarril(ev.clientY);
                const soltar = () => {
                    rail.classList.remove("activo");
                    window.removeEventListener("mousemove", mover);
                    window.removeEventListener("mouseup", soltar);
                    // El estado y el tamano del nodo se guardan al soltar, no en
                    // cada pixel del recorrido.
                    writeState();
                    fit_();
                };
                window.addEventListener("mousemove", mover);
                window.addEventListener("mouseup", soltar);
            });

            // El nodo se mueve arrastrando su fondo; dentro del panel eso seria
            // un estorbo, asi que el raton se queda aqui.
            container.addEventListener("mousedown", (e) => e.stopPropagation());

            /* --- alta del widget y tamano --- */

            const domW = this.addDOMWidget("UI", "HTML", container, { margin: 6 });
            domW.serialize = false;
            if (domW.options) {
                domW.options.serialize = false;
                // Alto exacto por las dos puntas: asi el hueco que reserva
                // LiteGraph y el que ocupa el panel son el mismo, y el wrapper
                // nunca sobra por debajo tapando lo que haya bajo el nodo.
                domW.options.getMinHeight = () => panelHeight();
                domW.options.getMaxHeight = () => panelHeight();
            }

            const fit_ = () => {
                const need = self.computeSize();
                self.setSize([Math.max(minWidth(), self.size[0]), need[1]]);
                app.graph?.setDirtyCanvas(true, true);
            };

            const originalOnResize = this.onResize;
            this.onResize = function (size) {
                if (originalOnResize) originalOnResize.apply(this, arguments);
                const min = minWidth();
                if (size[0] < min) size[0] = min;
            };

            /* --- avisos, para no tener que estar mirando --- */

            // 1) Widgets propios: se sabe en el acto, sin esperar a un repintado.
            // TODOS los que cambian lo que se ve. Dejar fuera outpaint y
            // pad_color hacia que encenderlos no repintara: el tirador seguia
            // oculto y el pie decia "padded" con el outpaint ya encendido,
            // hasta que el lienzo se repintara por cualquier otro motivo.
            for (const name of ["width", "height", "scale_method", "crop", "pad_color", "outpaint"]) {
                const w = self.widgets?.find(x => x.name === name);
                if (!w) continue;
                const prev = w.callback;
                w.callback = function (...args) {
                    const r = prev?.apply(this, args);
                    syncIfChanged();
                    return r;
                };
            }

            // 2) Cuando el tamano llega por cable, quien lo cambia es OTRO nodo,
            // y asignar el valor de un widget a pelo no dispara ningun evento de
            // LiteGraph. Resolution Calc avisa por aqui al terminar su cuenta.
            const onSizes = () => syncIfChanged();
            window.addEventListener("academia:sizes-changed", onSizes);

            // 3) Conectar o soltar un cable cambia de donde sale el tamano, y
            // tambien que ranuras se ensenan.
            const originalConn = this.onConnectionsChange;
            this.onConnectionsChange = function (...args) {
                const r = originalConn?.apply(this, args);
                syncIfChanged();
                render();
                fit_();
                return r;
            };

            const originalRemoved = this.onRemoved;
            this.onRemoved = function () {
                window.removeEventListener("academia:sizes-changed", onSizes);
                if (originalRemoved) originalRemoved.apply(this, arguments);
            };

            // Red de seguridad para nodos de origen que no avisan de nada:
            // comparar tres primitivas no asigna memoria y solo baja al DOM
            // cuando el valor ha cambiado de verdad.
            const originalDrawFg = this.onDrawForeground;
            this.onDrawForeground = function (ctx) {
                if (originalDrawFg) originalDrawFg.apply(this, arguments);
                syncIfChanged();
            };

            self.asdRefresh = () => { readState(); render(); syncIfChanged(); fit_(); };

            readState();
            render();
            // El tamano inicial se pide tras el primer layout: antes de eso
            // computeSize() aun no conoce las filas de los doce conectores.
            setTimeout(fit_, 0);
        };

        // Los widgets guardados se restauran DESPUES de onNodeCreated, asi que
        // el panel se dibujo con el estado vacio. Hay que releerlo.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            if (onConfigure) onConfigure.apply(this, arguments);
            // configure restaura las salidas copiando indices sobre el array que
            // ya existe, y NO lo recorta. Un workflow guardado cuando habia doce
            // ranuras se trae las dos que ya no existen, en rojo y sin nada
            // detras. Se quitan aqui para no obligar a recrear el nodo a mano.
            //
            // Se miran por NOMBRE, no por posicion: contar salidas se cargaria
            // tambien Reference_active, que va detras de las imagenes.
            const sobra = (o) => {
                const m = /^image_(\d+)$/.exec(String(o && o.name || ""));
                return !!m && Number(m[1]) > SLOTS;
            };
            for (let i = (this.outputs ? this.outputs.length : 0) - 1; i >= 0; i--) {
                if (sobra(this.outputs[i])) this.removeOutput(i);
            }
            setTimeout(() => this.asdRefresh?.(), 32);
        };
    },
});
