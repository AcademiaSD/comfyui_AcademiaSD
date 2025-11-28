import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

app.registerExtension({
    name: "AcademiaSD.GeminiTextDisplay",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_Gemini_Node") {
            // Cuando el nodo se ejecuta y recibe datos del servidor
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                onExecuted?.apply(this, arguments);

                // Verificamos si hay texto en la respuesta
                if (message?.text) {
                    const text = message.text[0];
                    
                    // Buscamos si ya creamos el widget de texto anteriormente
                    const widgetName = "Gemini Response";
                    const widget = this.widgets.find(w => w.name === widgetName);

                    if (widget) {
                        // Si existe, actualizamos el valor
                        widget.value = text;
                    } else {
                        // Si no existe, lo creamos usando los widgets nativos de ComfyUI
                        // Truco: Creamos un string widget y lo hacemos multiline
                        const w = ComfyWidgets["STRING"](this, widgetName, ["STRING", { multiline: true }], app).widget;
                        w.inputEl.readOnly = true; // Lo hacemos de solo lectura
                        w.inputEl.style.opacity = 0.8;
                        w.inputEl.style.backgroundColor = "#222"; 
                        w.value = text;
                    }
                    
                    // Ajustamos el tamaño del nodo si es necesario
                    this.onResize?.(this.size);
                }
            };
        }
    }
});