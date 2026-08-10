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
                this.addDOMWidget("Display", "HTML", container);

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

                [mpW, ratioW, divW, customToggleW, customRatioW].forEach(w => {
                    if(w) w.callback = () => { calc(); };
                });

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
                this.addWidget("button", "🔄 Swap Ratio", null, () => {
                    const p = customToggleW.value ? customRatioW.value.split(":") : ratioW.value.split(" ")[0].split(":");
                    customToggleW.value = true;
                    customRatioW.value = `${p[1]}:${p[0]}`;
                    calc();
                });

                calc();
            };
        }
    }
});