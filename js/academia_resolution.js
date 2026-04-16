import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.ResolutionSelector",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_Resolution") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const presetWidget = this.widgets.find(w => w.name === "preset");
                const widthWidget = this.widgets.find(w => w.name === "width");
                const heightWidget = this.widgets.find(w => w.name === "height");

                // --- 1. Lógica del Preset ---
                presetWidget.callback = (val) => {
                    if (val && val !== "Custom") {
                        const parts = val.split("x");
                        if (parts.length === 2) {
                            widthWidget.value = parseInt(parts[0]);
                            heightWidget.value = parseInt(parts[1]);
                            app.graph.setDirtyCanvas(true, true);
                        }
                    }
                };

                // --- 2. Lógica para resetear a "Custom" si se editan los números ---
                const setCustom = () => {
                    if (presetWidget.value !== "Custom") {
                        presetWidget.value = "Custom";
                    }
                };
                widthWidget.callback = setCustom;
                heightWidget.callback = setCustom;

                // --- 3. Botones (en columna) ---
                this.addWidget("button", "➗ Half", null, () => {
                    widthWidget.value = Math.max(64, Math.round(widthWidget.value / 2 / 8) * 8);
                    heightWidget.value = Math.max(64, Math.round(heightWidget.value / 2 / 8) * 8);
                    setCustom();
                    app.graph.setDirtyCanvas(true, true);
                });

                this.addWidget("button", "✖️ Double", null, () => {
                    widthWidget.value = Math.round(widthWidget.value * 2 / 8) * 8;
                    heightWidget.value = Math.round(heightWidget.value * 2 / 8) * 8;
                    setCustom();
                    app.graph.setDirtyCanvas(true, true);
                });

                this.addWidget("button", "🔄 Swap", null, () => {
                    const temp = widthWidget.value;
                    widthWidget.value = heightWidget.value;
                    heightWidget.value = temp;
                    setCustom();
                    app.graph.setDirtyCanvas(true, true);
                });

                this.addWidget("button", "📐 Get Size", null, async () => {
                    const inputLink = this.inputs[0]?.link;
                    if (!inputLink) return;

                    const link = app.graph.links[inputLink];
                    const originNode = app.graph.getNodeById(link.origin_id);
                    const imageWidget = originNode.widgets.find(w => w.name === "image");

                    if (imageWidget && imageWidget.value) {
                        const resp = await fetch(`/academia/get_image_size?filename=${encodeURIComponent(imageWidget.value)}`);
                        const data = await resp.json();
                        if (data.width && data.height) {
                            widthWidget.value = data.width;
                            heightWidget.value = data.height;
                            setCustom();
                            app.graph.setDirtyCanvas(true, true);
                        }
                    }
                });
            };
        }
    }
});