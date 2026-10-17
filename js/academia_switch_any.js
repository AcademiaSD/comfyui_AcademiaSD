import { app } from "../../scripts/app.js";

// Switch Any: las entradas de datos crecen solas. Siempre hay una libre detras
// de la ultima conectada (minimo dos), hasta el maximo que admite el nodo.
const NODE_NAME = "AcademiaSD_SwitchAny";
const MAX = 10;
const DATA = /^input_(\d+)$/;

function sync(node) {
    if (!node.inputs) return;
    let last = 0;
    for (const inp of node.inputs) {
        const m = DATA.exec(inp.name);
        if (m && inp.link != null) last = Math.max(last, +m[1]);
    }
    const want = Math.min(MAX, Math.max(2, last + 1));
    for (let k = node.inputs.length - 1; k >= 0; k--) {
        const m = DATA.exec(node.inputs[k].name);
        if (m && +m[1] > want && node.inputs[k].link == null) node.removeInput(k);
    }
    for (let n = 1; n <= want; n++) {
        if (!node.inputs.some((i) => i.name === `input_${n}`)) node.addInput(`input_${n}`, "*");
    }
    const size = node.computeSize();
    // Un margen al pie para la etiqueta del resultado.
    node.setSize([Math.max(node.size[0], size[0]), size[1] + 18]);
    app.graph?.setDirtyCanvas(true, true);
}

app.registerExtension({
    name: "AcademiaSD.SwitchAny",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            setTimeout(() => sync(this), 0);
            return r;
        };

        // Al cargar un workflow las entradas guardadas llegan despues de onNodeCreated.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            setTimeout(() => sync(this), 0);
            return r;
        };

        // Tras cada ejecucion, la entrada elegida (y su valor si es un numero) al pie del nodo.
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            this.asdSwitchLabel = message?.switch_any?.[0] ?? "";
            app.graph?.setDirtyCanvas(true, false);
        };

        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground?.apply(this, arguments);
            if (!this.asdSwitchLabel || this.flags?.collapsed) return;
            ctx.save();
            ctx.font = "bold 13px sans-serif";
            ctx.fillStyle = "#8ef0a6";
            ctx.textAlign = "right";
            ctx.fillText(this.asdSwitchLabel, this.size[0] - 10, this.size[1] - 8);
            ctx.restore();
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const r = onConnectionsChange?.apply(this, arguments);
            // Fuera del propio evento: cambiar las entradas mientras litegraph
            // aun esta enlazando romperia el enlace en curso.
            setTimeout(() => sync(this), 0);
            return r;
        };
    },
});
