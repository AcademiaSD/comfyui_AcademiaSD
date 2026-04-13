import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

app.registerExtension({
    name: "AcademiaSD.ResolutionDisplay",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_ResolutionDisplay") {
            
            // 1. Crear la caja de texto visual al momento de añadir el nodo
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                // Usar el widget STRING nativo de ComfyUI en modo multilínea
                this.textWidget = ComfyWidgets.STRING(this, "ResolutionInfo", ["STRING", { multiline: true }], app).widget;
                
                // Estilizar la caja (Estilo terminal hacker, centrado y no editable)
                this.textWidget.inputEl.readOnly = true;
                this.textWidget.inputEl.style.backgroundColor = "#111";
                this.textWidget.inputEl.style.color = "#00ff00"; // Letras verdes
                this.textWidget.inputEl.style.textAlign = "center";
                this.textWidget.inputEl.style.fontSize = "14px";
                this.textWidget.inputEl.style.fontFamily = "monospace";
                this.textWidget.inputEl.style.border = "1px solid #333";
                this.textWidget.inputEl.style.borderRadius = "4px";
                this.textWidget.inputEl.style.padding = "10px";
                this.textWidget.inputEl.style.marginTop = "10px";
                
                // Texto por defecto
                this.textWidget.value = "Waiting for execution...";
                
                // Ajustar el tamaño inicial del nodo
                this.size = [300, 160];
            };

            // 2. Actualizar el texto cuando Python termina de calcular
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                if (onExecuted) onExecuted.apply(this, arguments);

                // Si Python envió el mensaje 'text', lo pintamos en la caja
                if (this.textWidget && message && message.text) {
                    this.textWidget.value = message.text[0];
                }
            };
        }
    }
});