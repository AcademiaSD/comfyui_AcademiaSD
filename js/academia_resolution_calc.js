import { app } from "../../scripts/app.js";

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

function parseRatio(text) {
    const parts = String(text ?? "").split(":").map((p) => parseFloat(p.trim()));
    if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n) && n > 0)) return null;
    return parts;
}

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

                const presets = () => (ratioW.options?.values || []).filter(v => !isCustom(v));
                // Busca el preset cuya proporcion es exactamente esta ("16:9").
                const presetFor = (ratioText) => {
                    const p = parseRatio(ratioText);
                    if (!p) return null;
                    const [a, b] = simplify(p[0], p[1]);
                    return presets().find(v => head(v) === `${a}:${b}`) || null;
                };

                const container = document.createElement("div");
                container.style.cssText = "width:100%; display:flex; flex-direction:column; align-items:center; padding:8px; background:#111; border-radius:6px; border:1px solid #444; margin-top:5px;";
                const resLabel = document.createElement("div");
                resLabel.style.cssText = "color:#00ff00; font-size:16px; font-weight:bold; font-family:monospace;";
                const mpLabel = document.createElement("div");
                mpLabel.style.cssText = "color:#888; font-size:11px; margin-top:2px; font-family:monospace;";
                const msgLabel = document.createElement("div");
                msgLabel.style.cssText = "color:#d29922; font-size:10px; margin-top:2px; font-family:monospace; display:none;";
                container.appendChild(resLabel);
                container.appendChild(mpLabel);
                container.appendChild(msgLabel);
                const displayW = this.addDOMWidget("Display", "HTML", container);
                // No es una entrada del nodo: no tiene por que viajar en el prompt.
                displayW.serialize = false;
                if (displayW.options) displayW.options.serialize = false;

                let msgTimer = null;
                const note = (text) => {
                    msgLabel.innerText = text;
                    msgLabel.style.display = text ? "" : "none";
                    clearTimeout(msgTimer);
                    if (text) msgTimer = setTimeout(() => { msgLabel.style.display = "none"; }, 6000);
                };

                const activeRatio = () =>
                    parseRatio(customToggleW.value || isCustom(ratioW.value)
                               ? customRatioW.value
                               : head(ratioW.value));

                const calc = () => {
                    const p = activeRatio();
                    if (!p) {
                        resLabel.innerText = "— x —";
                        mpLabel.innerText = "(invalid ratio)";
                        return;
                    }
                    const [wr, hr] = p;
                    const div = parseInt(divW.value);
                    const area = mpW.value * 1048576;
                    const ratio = wr / hr;
                    const h = Math.sqrt(area / ratio);
                    const w = h * ratio;
                    const wf = Math.max(div, Math.round(w / div) * div);
                    const hf = Math.max(div, Math.round(h / div) * div);
                    resLabel.innerText = `${wf} x ${hf}`;

                    // Mientras la proporcion siga siendo la de la imagen de
                    // referencia, se ensena su tamano original: es lo que permite
                    // bajar los MP sabiendo de donde vienes. Se borra solo en
                    // cuanto cambias la proporcion.
                    let ref = "";
                    const rs = self.properties?.ref_size;
                    if (rs?.w && rs?.h) {
                        const [rw, rh] = simplify(rs.w, rs.h);
                        const [cw, ch] = simplify(wr * 1000, hr * 1000);
                        if (rw === cw && rh === ch) ref = `  ·  ref ${rs.w}×${rs.h}`;
                    }
                    mpLabel.innerText = `(Real: ${((wf * hf) / 1048576).toFixed(2)} MP)${ref}`;
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
                hook(mpW);
                hook(divW);
                hook(customRatioW);
                hook(ratioW, syncFromDropdown);
                hook(customToggleW, syncFromToggle);

                // Los valores guardados se restauran DESPUES de onNodeCreated, asi
                // que el display de arriba se calculo con los valores por defecto.
                // Sin esto, al abrir un workflow el LED ensena una resolucion que
                // no es la que recibe Python.
                this.__academiaResCalc = calc;

                /* --- tomar la medida de la imagen de referencia --- */

                // Atraviesa reroutes y nodos de paso hasta dar con un Load Image.
                const findImageWidget = () => {
                    let inp = self.inputs?.find(i => i.type === "IMAGE") || self.inputs?.[0];
                    for (let guard = 0; guard < 16; guard++) {
                        if (!inp || inp.link == null) return null;
                        const link = app.graph.links[inp.link];
                        if (!link) return null;
                        const origin = app.graph.getNodeById(link.origin_id);
                        if (!origin) return null;
                        const w = origin.widgets?.find(x => x.name === "image");
                        if (w?.value) return w;
                        inp = origin.inputs?.find(i => i.link != null && (i.type === "IMAGE" || i.type === "*"));
                    }
                    return null;
                };

                const applyReference = (width, height) => {
                    self.properties.ref_size = { w: width, h: height };
                    mpW.value = Math.round(((width * height) / 1048576) * 10000) / 10000;

                    const [rw, rh] = simplify(width, height);
                    const preset = presetFor(`${rw}:${rh}`);
                    if (preset) {
                        // La imagen encaja en una proporcion de la lista: se usa
                        // esa y el nodo se queda en modo preset.
                        ratioW.value = preset;
                        customToggleW.value = false;
                        self.properties.last_preset = preset;
                        note(`${width}×${height} → ${rw}:${rh}`);
                    } else {
                        // No encaja en ninguna: ratio manual, y el desplegable lo
                        // dice en vez de seguir ensenando un preset que no se usa.
                        customRatioW.value = `${rw}:${rh}`;
                        customToggleW.value = true;
                        ratioW.value = CUSTOM;
                        note(`${width}×${height} → Custom ${rw}:${rh}`);
                    }
                    calc();
                    app.graph.setDirtyCanvas(true, true);
                };

                this.addWidget("button", "📐 Get Size from Image", null, async () => {
                    const imgWidget = findImageWidget();
                    if (!imgWidget) {
                        note("⚠ connect the image input to a Load Image node");
                        app.graph.setDirtyCanvas(true, true);
                        return;
                    }
                    try {
                        const resp = await fetch(`/academia_res/get_image_size?filename=${encodeURIComponent(imgWidget.value)}`);
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
                        customRatioW.value = `${p[1]}:${p[0]}`;
                    } else {
                        const [a, b] = head(ratioW.value).split(":");
                        const mirror = presetFor(`${b}:${a}`);
                        if (mirror) {
                            ratioW.value = mirror;              // se queda en preset
                            self.properties.last_preset = mirror;
                        } else {
                            // Preset sin pareja en la lista: la unica forma de
                            // expresarlo es el ratio manual.
                            customRatioW.value = `${b}:${a}`;
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
            };
        }
    }
});
