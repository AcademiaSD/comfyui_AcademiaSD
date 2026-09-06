import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.ResolutionCalc",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_ResolutionCalc") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const mpW = this.widgets.find(w => w.name === "megapixel");
                const ratioW = this.widgets.find(w => w.name === "aspect_ratio");
                const divW = this.widgets.find(w => w.name === "divisible_by");
                const customToggleW = this.widgets.find(w => w.name === "custom_ratio");
                const customRatioW = this.widgets.find(w => w.name === "custom_aspect_ratio");

                const container = document.createElement("div");
                container.style.cssText = "width:100%; display:flex; flex-direction:column; align-items:center; padding:8px; background:#111; border-radius:6px; border:1px solid #444; margin-top:5px;";
                const resLabel = document.createElement("div");
                resLabel.style.cssText = "color:#00ff00; font-size:16px; font-weight:bold; font-family:monospace;";
                const mpLabel = document.createElement("div");
                mpLabel.style.cssText = "color:#888; font-size:11px; margin-top:2px; font-family:monospace;";
                container.appendChild(resLabel);
                container.appendChild(mpLabel);
                const displayW = this.addDOMWidget("Display", "HTML", container);
                // No es una entrada del nodo: no tiene por que viajar en el prompt.
                displayW.serialize = false;
                if (displayW.options) displayW.options.serialize = false;

                const calc = () => {
                    const mp = mpW.value;
                    const div = parseInt(divW.value);
                    let wr = 1, hr = 1;
                    if(customToggleW.value) {
                        const p = customRatioW.value.split(":");
                        wr = parseFloat(p[0]); hr = parseFloat(p[1]);
                    } else {
                        const p = ratioW.value.split(" ")[0].split(":");
                        wr = parseFloat(p[0]); hr = parseFloat(p[1]);
                    }
                    const area = mp * 1048576;
                    const ratio = wr / hr;
                    const h = Math.sqrt(area / ratio);
                    const w = h * ratio;
                    const wf = Math.max(div, Math.round(w / div) * div);
                    const hf = Math.max(div, Math.round(h / div) * div);
                    resLabel.innerText = `${wf} x ${hf}`;
                    mpLabel.innerText = `(Real: ${((wf*hf)/1048576).toFixed(2)} MP)`;
                };

                // Encadenar, no reemplazar: si el frontend le pone un callback
                // propio a un widget, sustituirlo lo romperia en silencio.
                [mpW, ratioW, divW, customToggleW, customRatioW].forEach(w => {
                    if (!w) return;
                    const prev = w.callback;
                    w.callback = function (...args) {
                        const r = prev?.apply(this, args);
                        calc();
                        return r;
                    };
                });

                // Los valores guardados se restauran DESPUES de onNodeCreated, asi
                // que el display de arriba se calculo con los valores por defecto.
                // Sin esto, al abrir un workflow el LED ensena una resolucion que
                // no es la que recibe Python.
                this.__academiaResCalc = calc;

                this.addWidget("button", "📐 Get Size from Image", null, async () => {
                    if(!this.inputs[0]?.link) return;
                    const link = app.graph.links[this.inputs[0].link];
                    const originNode = app.graph.getNodeById(link.origin_id);
                    const imgWidget = originNode.widgets?.find(w => w.name === "image");
                    if(imgWidget?.value) {
                        const resp = await fetch(`/academia_res/get_image_size?filename=${encodeURIComponent(imgWidget.value)}`);
                        const data = await resp.json();
                        if(data.width) {
                            customToggleW.value = true;
                            customRatioW.value = `${data.width}:${data.height}`;
                            mpW.value = (data.width * data.height) / 1048576;
                            calc();
                            app.graph.setDirtyCanvas(true, true);
                        }
                    }
                });

                this.addWidget("button", "➗ Half MP", null, () => { mpW.value = Math.max(0.1, mpW.value / 2); calc(); });
                this.addWidget("button", "✖️ Double MP", null, () => { mpW.value = mpW.value * 2; calc(); });
                // Intercambia la resolucion actual: vertical <-> horizontal.
                // Invertir el ratio es exactamente eso: como w=raiz(A*r) y
                // h=raiz(A/r), usar 1/r intercambia ambos, y divisible_by redondea
                // igual a cada uno. Por eso NO hace falta tocar custom_ratio: se
                // queda en el modo en el que estes.
                this.addWidget("button", "🔄 Swap Resolution", null, () => {
                    if (customToggleW.value) {
                        const p = String(customRatioW.value).split(":");
                        if (p.length !== 2) return;
                        customRatioW.value = `${p[1].trim()}:${p[0].trim()}`;
                    } else {
                        const [a, b] = ratioW.value.split(" ")[0].split(":");
                        const mirror = `${b}:${a}`;
                        const values = ratioW.options?.values || [];
                        const found = values.find(v => String(v).split(" ")[0] === mirror);
                        if (found) {
                            ratioW.value = found;          // se queda en preset
                        } else {
                            // Preset sin pareja en la lista: la unica forma de
                            // expresarlo es el ratio manual.
                            customToggleW.value = true;
                            customRatioW.value = mirror;
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