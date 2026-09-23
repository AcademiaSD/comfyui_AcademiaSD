import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const CUSTOM = "Custom";

const isCustom = (v) => String(v ?? "").split(" ")[0] === CUSTOM;
const head = (v) => String(v ?? "").split(" ")[0];          // "16:9 (Panorama)" -> "16:9"

function gcd(a, b) {
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b) [a, b] = [b, a % b];
    return a || 1;
}

// 1920x1080 -> [16, 9]. Exacto a proposito: aproximar cambiaria la proporcion
// de la imagen de referencia, que es justo lo que hay que conservar.
function simplify(w, h) {
    const g = gcd(w, h);
    return [Math.round(w / g), Math.round(h / g)];
}

// Cuanto se deja que se mueva una proporcion a cambio de poder leerla.
const RATIO_MAX_DRIFT = 0.015;   // 1.5 %

// "259:227" no se lee; "26:23" si. Se baja de diez en diez simplificando en
// cada paso, que es como se acorta a ojo, pero cada paso solo vale si la
// proporcion no se aleja mas de RATIO_MAX_DRIFT de la original: "1672:941" se
// queda en "167:94" (0.01 %) en vez de acabar en un "17:9" que es un 6 % de
// desvio, o sea otra imagen. Tambien para si el lado corto fuese a quedarse en
// nada: una proporcion extrema como 128:1 no se puede acortar sin mentir.
function friendlyRatio(w, h, maxDigits = 2) {
    let a = Number(w), b = Number(h);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
    // Escalar antes de simplificar: si no, "1.5:1" se redondearia a "2:1".
    if (!Number.isInteger(a) || !Number.isInteger(b)) { a *= 1000; b *= 1000; }
    [a, b] = simplify(a, b);
    const target = a / b;
    const limit = Math.pow(10, maxDigits) - 1;
    for (let guard = 0; guard < 8 && (a > limit || b > limit); guard++) {
        if (Math.min(a, b) < 10) break;
        const [na, nb] = simplify(Math.round(a / 10), Math.round(b / 10));
        // El desvio se mide contra la proporcion ORIGINAL, no contra el paso
        // anterior: si no, ocho pasos pequenos acabarian lejisimos.
        if (Math.abs(na / nb - target) / target > RATIO_MAX_DRIFT) break;
        [a, b] = [na, nb];
    }
    return [a, b];
}

// La misma cuenta que hace Python. Compartirla es lo que permite comprobar
// aqui, antes de tocar nada, que resolucion va a salir de verdad.
function sizeFrom(megapixel, wr, hr, div) {
    const area = megapixel * 1048576;
    const ratio = wr / hr;
    const h = Math.sqrt(area / ratio);
    const w = h * ratio;
    return [Math.max(div, Math.round(w / div) * div),
            Math.max(div, Math.round(h / div) * div)];
}

function parseRatio(text) {
    const parts = String(text ?? "").split(":").map((p) => parseFloat(p.trim()));
    if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n) && n > 0)) return null;
    return parts;
}

// El tamano que Python ha visto de verdad, por nodo. Es lo unico que vale
// cuando la imagen no viene de un fichero.
const seenSizes = new Map();
api.addEventListener("academia.rescalc.image_size", (e) => {
    const d = e.detail || {};
    if (!d.node_id || !d.width || !d.height) return;
    seenSizes.set(String(d.node_id), { w: d.width, h: d.height });
});

app.registerExtension({
    name: "AcademiaSD.ResolutionCalc",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_ResolutionCalc") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);
                const self = this;

                const mpW = this.widgets.find(w => w.name === "megapixel");
                const ratioW = this.widgets.find(w => w.name === "aspect_ratio");
                const divW = this.widgets.find(w => w.name === "divisible_by");
                const customToggleW = this.widgets.find(w => w.name === "custom_ratio");
                const customRatioW = this.widgets.find(w => w.name === "custom_aspect_ratio");
                // Se crean mas abajo, despues del recuadro del resultado.
                let widthW = null, heightW = null;

                const presets = () => (ratioW.options?.values || []).filter(v => !isCustom(v));
                // Busca el preset cuya proporcion es exactamente esta ("16:9").
                const presetFor = (ratioText) => {
                    const p = parseRatio(ratioText);
                    if (!p) return null;
                    const [a, b] = simplify(p[0], p[1]);
                    return presets().find(v => head(v) === `${a}:${b}`) || null;
                };

                const container = document.createElement("div");
                // overflow:hidden es la garantia dura de que nada se pinte fuera
                // del recuadro negro pase lo que pase con la altura.
                container.style.cssText = "width:100%; box-sizing:border-box; overflow:hidden; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; padding:10px 8px 12px; background:#111; border-radius:6px; border:1px solid #444; margin-top:5px;";
                const resLabel = document.createElement("div");
                resLabel.style.cssText = "flex:0 0 auto; line-height:20px; color:#00ff00; font-size:16px; font-weight:bold; font-family:monospace;";
                // Los megapixeles REALES, los de despues de redondear por
                // divisible_by, no salen en ningun otro sitio: el widget
                // megapixel es el objetivo, no el resultado.
                const mpLabel = document.createElement("div");
                mpLabel.style.cssText = "flex:0 0 auto; line-height:14px; white-space:nowrap; color:#888; font-size:11px; font-family:monospace;";
                container.appendChild(resLabel);
                container.appendChild(mpLabel);
                const displayW = this.addDOMWidget("Display", "HTML", container);
                // No es una entrada del nodo: no tiene por que viajar en el prompt.
                displayW.serialize = false;
                if (displayW.options) displayW.options.serialize = false;
                // NO medir el DOM. ComfyUI dimensiona los widgets DOM en pixeles
                // de PANTALLA (a zoom 2.3 una linea de 20 px mide 60), mientras que
                // node.size va en unidades de grafo. Mezclarlos hacia crecer la caja
                // sin parar. El layout de este recuadro lo definimos aqui entero,
                // asi que su altura es una constante exacta en unidades de grafo:
                //   padding 10 + linea 20 + hueco 4 + linea 14 + padding 12 + bordes 2
                const BOX_H = 62;
                const remeasure = () => {
                    const need = self.computeSize()[1];
                    // Solo crecer: un tamano puesto a mano por el usuario se respeta.
                    if (self.size[1] < need) {
                        self.setSize([self.size[0], need]);
                        app.graph.setDirtyCanvas(true, true);
                    }
                };
                if (displayW.options) {
                    displayW.options.getMinHeight = () => BOX_H;
                    displayW.options.getMaxHeight = () => BOX_H;
                }

                // El unico aviso que queda (no encuentro el Load Image) ocupa la
                // propia linea de la resolucion unos segundos y la devuelve: una
                // sola linea, ninguna altura extra, nada que pueda solaparse.
                let msgTimer = null;
                const note = (text) => {
                    clearTimeout(msgTimer);
                    mpLabel.innerText = text;
                    mpLabel.style.color = "#d29922";
                    remeasure();
                    msgTimer = setTimeout(() => calc(), 5000);
                };

                const activeRatio = () =>
                    parseRatio(customToggleW.value || isCustom(ratioW.value)
                               ? customRatioW.value
                               : head(ratioW.value));

                // "Custom OFF" quiere decir que custom_aspect_ratio no esta actuando.
                // Dejarlo con el ultimo valor escrito hacia creer que seguia en uso,
                // asi que al volver a modo preset el campo vuelve a su valor neutro.
                const resetCustomRatio = () => {
                    if (customToggleW.value || isCustom(ratioW.value)) return;   // esta en uso: no se toca
                    if (customRatioW.value === "1:1") return;
                    customRatioW.value = "1:1";
                };

                const calc = () => {
                    resetCustomRatio();
                    const p = activeRatio();
                    if (!p) {
                        resLabel.style.color = "#00ff00";
                        resLabel.style.fontSize = "16px";
                        resLabel.innerText = "— x —";
                        mpLabel.style.color = "#d29922";
                        mpLabel.innerText = "(invalid ratio)";
                        remeasure();
                        return;
                    }
                    const [wr, hr] = p;
                    const div = parseInt(divW.value);
                    const [wf, hf] = sizeFrom(mpW.value, wr, hr, div);
                    clearTimeout(msgTimer);
                    resLabel.style.color = "#00ff00";
                    resLabel.style.fontSize = "16px";
                    resLabel.innerText = `${wf} x ${hf}`;

                    // Mientras la proporcion siga siendo la de la imagen de
                    // referencia se ensena su tamano original: es lo que permite
                    // bajar los MP sabiendo de donde vienes. Desaparece solo en
                    // cuanto cambias la proporcion.
                    let ref = "";
                    const rs = self.properties?.ref_size;
                    if (rs?.w && rs?.h) {
                        // Comparar ya acortado: la proporcion guardada tambien se
                        // redondeo a dos digitos, si no el aviso no saldria nunca.
                        const a = friendlyRatio(rs.w, rs.h);
                        const b = friendlyRatio(wr * 1000, hr * 1000);
                        if (a && b && a[0] === b[0] && a[1] === b[1]) ref = `  ·  ref ${rs.w}×${rs.h}`;
                    }
                    mpLabel.style.color = "#888";
                    mpLabel.innerText = `(Real: ${((wf * hf) / 1048576).toFixed(2)} MP)${ref}`;

                    // width/height son el espejo editable del resultado: se
                    // reescriben SIEMPRE aqui, asi que tambien quedan al dia tras
                    // cargar el workflow, Half/Double MP, Swap o Get Size.
                    if (widthW) widthW.value = wf;
                    if (heightW) heightW.value = hf;
                    remeasure();

                    // Otros nodos leen WIDTH y HEIGHT de aqui. Asignar el valor de
                    // un widget a pelo NO dispara ningun evento de LiteGraph ni
                    // ensucia el lienzo, asi que quien lo lea se enteraria en el
                    // siguiente repintado que cayera por casualidad -- que puede
                    // tardar segundos si nadie toca nada. Se avisa a mano.
                    window.dispatchEvent(new CustomEvent("academia:sizes-changed",
                                                         { detail: { nodeId: self.id } }));
                    app.graph?.setDirtyCanvas(true, true);
                };

                /* --- el desplegable y el interruptor son el mismo ajuste --- */
                // Con "Custom" en la lista, el modo se ve sin abrir nada. Se
                // mantienen de acuerdo en los dos sentidos para que no puedan
                // contradecirse.
                const syncFromDropdown = () => {
                    if (isCustom(ratioW.value)) {
                        customToggleW.value = true;
                    } else {
                        customToggleW.value = false;
                        self.properties.last_preset = ratioW.value;
                    }
                };
                const syncFromToggle = () => {
                    if (customToggleW.value) {
                        if (!isCustom(ratioW.value)) {
                            self.properties.last_preset = ratioW.value;
                            ratioW.value = CUSTOM;
                        }
                    } else if (isCustom(ratioW.value)) {
                        ratioW.value = presetFor(customRatioW.value)
                                    || self.properties.last_preset
                                    || presets()[0];
                    }
                };

                // Encadenar, no reemplazar: si el frontend le pone un callback
                // propio a un widget, sustituirlo lo romperia en silencio.
                const hook = (w, before) => {
                    if (!w) return;
                    const prev = w.callback;
                    w.callback = function (...args) {
                        const r = prev?.apply(this, args);
                        try { before?.(); } catch (e) { console.error("[ResolutionCalc]", e); }
                        calc();
                        return r;
                    };
                };
                // Escribir aqui es pedir ratio manual. Encender el interruptor solo
                // evita que la regla de "OFF muestra 1:1" borre lo recien escrito.
                const onCustomRatioEdited = () => {
                    const p = parseRatio(customRatioW.value);
                    if (!p) return;                       // invalido: ya lo avisa calc()
                    const f = friendlyRatio(p[0], p[1]);
                    if (f) customRatioW.value = `${f[0]}:${f[1]}`;
                    if (!customToggleW.value && customRatioW.value !== "1:1") {
                        customToggleW.value = true;
                        syncFromToggle();
                    }
                };

                hook(mpW);
                hook(divW);
                hook(customRatioW, onCustomRatioEdited);
                hook(ratioW, syncFromDropdown);
                hook(customToggleW, syncFromToggle);

                // Los valores guardados se restauran DESPUES de onNodeCreated, asi
                // que el display de arriba se calculo con los valores por defecto.
                // Sin esto, al abrir un workflow el LED ensena una resolucion que
                // no es la que recibe Python.
                this.__academiaResCalc = calc;

                // Recablear la entrada invalida lo medido: el tamano guardado es
                // el de la imagen anterior, y darlo por bueno seria mentir.
                const originalConn = this.onConnectionsChange;
                this.onConnectionsChange = function (...args) {
                    const r = originalConn?.apply(this, args);
                    seenSizes.delete(String(self.id));
                    return r;
                };

                /* --- tomar la medida de la imagen de referencia --- */

                // Atraviesa reroutes y nodos de paso hasta dar con el fichero del
                // que sale la imagen. Devuelve el NOMBRE, no el widget: no todos
                // los nodos que sirven una imagen la guardan en uno.
                const findImageFile = () => {
                    let inp = self.inputs?.find(i => i.type === "IMAGE") || self.inputs?.[0];
                    for (let guard = 0; guard < 16; guard++) {
                        if (!inp || inp.link == null) return null;
                        const link = app.graph.links[inp.link];
                        if (!link) return null;
                        const origin = app.graph.getNodeById(link.origin_id);
                        if (!origin) return null;

                        // Nodos que sirven una imagen distinta por cada salida
                        // (Multi Image Reference): hay que preguntar por la que
                        // llega, no por "la suya", porque tiene doce.
                        const served = origin.asdRefFileForOutput?.(link.origin_slot);
                        if (served) return served;

                        const w = origin.widgets?.find(x => x.name === "image");
                        if (w?.value) return w.value;
                        inp = origin.inputs?.find(i => i.link != null && (i.type === "IMAGE" || i.type === "*"));
                    }
                    return null;
                };

                // Sin cable de entrada, se mira a QUIEN le estamos dando el tamano.
                // Tirar un cable de imagen hacia aca cerraria un ciclo -- este
                // nodo ya le manda WIDTH y HEIGHT -- y ComfyUI rechaza el grafo
                // entero. Pero el cable que hace falta ya existe, solo que en el
                // otro sentido, asi que se recorre al reves y no hay ciclo.
                const findImageFileDownstream = () => {
                    for (const out of self.outputs || []) {
                        for (const linkId of out.links || []) {
                            const link = app.graph.links[linkId];
                            const target = link ? app.graph.getNodeById(link.target_id) : null;
                            const f = target?.asdPrimaryRefFile?.();
                            if (f) return f;
                        }
                    }
                    return null;
                };

                const applyReference = (width, height) => {
                    self.properties.ref_size = { w: width, h: height };
                    mpW.value = Math.round(((width * height) / 1048576) * 10000) / 10000;

                    // Acortar ANTES de buscar preset: una foto de 1920x1279 se lee
                    // como 3:2 y entra en la lista, en vez de irse a ratio manual.
                    const [rw, rh] = friendlyRatio(width, height) || simplify(width, height);
                    const preset = presetFor(`${rw}:${rh}`);
                    if (preset) {
                        // La imagen encaja en una proporcion de la lista: se usa
                        // esa y el nodo se queda en modo preset.
                        ratioW.value = preset;
                        customToggleW.value = false;
                        self.properties.last_preset = preset;
                    } else {
                        // No encaja en ninguna: ratio manual, y el desplegable lo
                        // dice en vez de seguir ensenando un preset que no se usa.
                        customRatioW.value = `${rw}:${rh}`;
                        customToggleW.value = true;
                        ratioW.value = CUSTOM;
                    }
                    calc();
                    app.graph.setDirtyCanvas(true, true);
                };

                /* --- escribir el tamano a mano --- */

                // La proporcion corta se queda SOLO si devuelve el mismo tamano.
                // 776x1000 es 97:125, y acortarlo a 10:13 moveria el alto a 1008:
                // entre un numero bonito y respetar lo que has escrito, gana lo
                // segundo, asi que en ese caso se deja la proporcion exacta.
                const ratioFor = (w, h, div, mp) => {
                    const exact = simplify(w, h);
                    const f = friendlyRatio(w, h);
                    if (!f) return exact;
                    if (f[0] === exact[0] && f[1] === exact[1]) return exact;
                    const [tw, th] = sizeFrom(mp, f[0], f[1], div);
                    return (tw === w && th === h) ? f : exact;
                };

                // Escribir el ancho o el alto es otra forma de pedir un tamano:
                // se cuadra al divisible_by y de ahi salen los megapixeles y la
                // proporcion, que es lo que Python usa de verdad. Por eso el nodo
                // da el mismo resultado aunque este JS no llegue a ejecutarse.
                const applyManualSize = () => {
                    const div = parseInt(divW.value) || 8;
                    const snap = (v) => {
                        const n = Math.max(1, Number(v) || 0);
                        return Math.max(div, Math.round(n / div) * div);
                    };
                    const w = snap(widthW.value);
                    const h = snap(heightW.value);

                    // Los limites se leen del propio widget para no poder
                    // contradecir a Python: pasarse invalidaria el prompt entero.
                    const mpMin = mpW.options?.min ?? 0.1;
                    const mpMax = mpW.options?.max ?? 100;
                    const mp = Math.min(mpMax, Math.max(mpMin, (w * h) / 1048576));
                    mpW.value = Math.round(mp * 10000) / 10000;

                    const [rw, rh] = ratioFor(w, h, div, mpW.value);
                    const preset = presetFor(`${rw}:${rh}`);
                    if (preset) {
                        ratioW.value = preset;
                        customToggleW.value = false;
                        self.properties.last_preset = preset;
                    } else {
                        customRatioW.value = `${rw}:${rh}`;
                        customToggleW.value = true;
                        ratioW.value = CUSTOM;
                    }
                    // calc() reescribe width/height ya cuadrados: si escribiste 777
                    // con divisible_by 32, ves en el acto que el nodo usa 768.
                    calc();
                    app.graph.setDirtyCanvas(true, true);
                };

                const sizeOpts = { min: 64, max: 8192, step: 80, step2: 8, precision: 0 };
                widthW = this.addWidget("number", "width", 1024, applyManualSize, sizeOpts);
                heightW = this.addWidget("number", "height", 1024, applyManualSize, sizeOpts);
                // No son entradas del nodo, son el resultado hecho editable: se
                // recalculan solos al cargar. Si viajasen en widgets_values
                // desplazarian los valores de los workflows ya guardados.
                for (const w of [widthW, heightW]) {
                    w.serialize = false;
                    if (w.options) w.options.serialize = false;
                }

                this.addWidget("button", "📐 Get Size from Image", null, async () => {
                    // Orden a proposito: lo que Python ha medido manda sobre el
                    // fichero, porque un reescalado por el camino hace que el
                    // fichero de origen ya no diga el tamano que llega aqui.
                    const linked = self.inputs?.find(i => i.type === "IMAGE")?.link != null;
                    const seen = linked ? seenSizes.get(String(self.id)) : null;
                    if (seen) {
                        applyReference(seen.w, seen.h);
                        app.graph.setDirtyCanvas(true, true);
                        return;
                    }

                    const imgFile = findImageFile() || findImageFileDownstream();
                    if (!imgFile) {
                        note(linked ? "⚠ queue once so the size can be read"
                                    : "⚠ connect an image, or feed a node that has one");
                        app.graph.setDirtyCanvas(true, true);
                        return;
                    }
                    try {
                        const resp = await fetch(`/academia_res/get_image_size?filename=${encodeURIComponent(imgFile)}`);
                        const data = await resp.json();
                        if (data.width && data.height) applyReference(data.width, data.height);
                        else note("⚠ " + (data.error || "could not read that image"));
                    } catch (e) {
                        note("⚠ " + e.message);
                    }
                    app.graph.setDirtyCanvas(true, true);
                });

                this.addWidget("button", "➗ Half MP", null, () => { mpW.value = Math.max(0.1, mpW.value / 2); calc(); });
                this.addWidget("button", "✖️ Double MP", null, () => { mpW.value = mpW.value * 2; calc(); });

                // Intercambia la resolucion actual: vertical <-> horizontal.
                // Invertir el ratio es exactamente eso: como w=raiz(A*r) y
                // h=raiz(A/r), usar 1/r intercambia ambos, y divisible_by redondea
                // igual a cada uno. Por eso NO hace falta cambiar de modo.
                this.addWidget("button", "🔄 Swap Resolution", null, () => {
                    if (customToggleW.value || isCustom(ratioW.value)) {
                        const p = parseRatio(customRatioW.value);
                        if (!p) { note("⚠ invalid custom ratio"); return; }
                        const f = friendlyRatio(p[1], p[0]);
                        customRatioW.value = f ? `${f[0]}:${f[1]}` : `${p[1]}:${p[0]}`;
                    } else {
                        const [a, b] = head(ratioW.value).split(":");
                        const mirror = presetFor(`${b}:${a}`);
                        if (mirror) {
                            ratioW.value = mirror;              // se queda en preset
                            self.properties.last_preset = mirror;
                        } else {
                            // Preset sin pareja en la lista: la unica forma de
                            // expresarlo es el ratio manual.
                            const f = friendlyRatio(b, a);
                            customRatioW.value = f ? `${f[0]}:${f[1]}` : `${b}:${a}`;
                            customToggleW.value = true;
                            ratioW.value = CUSTOM;
                        }
                    }
                    calc();
                    app.graph.setDirtyCanvas(true, true);
                });

                for (const w of this.widgets) {
                    if (w.type === "button") {
                        w.serialize = false;
                        if (w.options) w.options.serialize = false;
                    }
                }

                calc();
            };

            // El display se pinta en onNodeCreated, antes de que ComfyUI
            // restaure los widgets guardados. Hay que rehacerlo despues.
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                if (onConfigure) onConfigure.apply(this, arguments);
                setTimeout(() => this.__academiaResCalc?.(), 60);
                setTimeout(() => this.__academiaResCalc?.(), 400);   // tras el layout
            };
        }
    }
});
