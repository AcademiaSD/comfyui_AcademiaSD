import { app } from "../../scripts/app.js";
import { runPrompt } from "./academia_queue.js";

const NODE_NAME = "AcademiaSD_PromptEnhancer";
const POSITIVE = "AcademiaSD_PositivePrompt";
const NEGATIVE = "AcademiaSD_NegativePrompt";

// El nodo y todo aquello de lo que depende, sacado del prompt del workflow: el
// cargador del CLIP, la imagen, lo que llegue por cable. Nada mas se ejecuta.
function upstream(output, id) {
    const keep = {};
    const stack = [id];
    while (stack.length) {
        const k = stack.pop();
        if (keep[k] || !output[k]) continue;
        keep[k] = structuredClone(output[k]);
        for (const v of Object.values(output[k].inputs)) {
            if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") stack.push(v[0]);
        }
    }
    return keep;
}

// A que Positive o Negative se manda: el unico que haya, o, si hay varios, el
// que este seleccionado. undefined = hay varios y ninguno elegido.
function target(type) {
    const all = (app.graph?._nodes || []).filter(n => n.type === type && n.asdSetText);
    if (all.length <= 1) return all[0] || null;
    const picked = all.filter(n => app.canvas?.selected_nodes?.[n.id]);
    return picked.length === 1 ? picked[0] : undefined;
}

// Sin salidas en pantalla: nada puede colgar de el, y por eso un Run del
// workflow no lo ejecuta nunca. `positive` tampoco se ensena: lo pone el boton.
function hideSockets(node) {
    for (let i = (node.outputs?.length || 0) - 1; i >= 0; i--) node.removeOutput(i);
    const i = node.inputs?.findIndex(x => x.name === "positive") ?? -1;
    if (i >= 0) node.removeInput(i);
}

// Textos de partida para la caja del prompt. Custom la deja vacia.
const PRESETS = {
    "Custom": "",
    "Describe image1": "Describe the image in great detail: the characters, the clothing, the background, "
        + "the objects and textures, the lighting, and the style.",
    "Enhance prompt": "Improve the prompt by including details that do not exist in the prompt, such as "
        + "scenery, lighting, clothing, and more.",
};

const AREA ="resize:none; box-sizing:border-box; padding:6px; background:#141414; color:#ddd;"
    + "border:1px solid #3d3d3d; border-radius:4px; font:12px sans-serif; line-height:1.35;";

app.registerExtension({
    name: "AcademiaSD.PromptEnhancer",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);
            const self = this;
            hideSockets(this);
            this.properties ??= {};

            // Un negativo es una lista corta: su caja, un tercio de la del prompt.
            for (const [name, min, max] of [["prompt", 120], ["negative_prompt", 44, 70]]) {
                const w = this.widgets?.find(x => x.name === name);
                if (!w?.options) continue;
                w.options.getMinHeight = () => min;
                if (max) w.options.getMaxHeight = () => max;
            }

            // El selector va justo encima de la caja que rellena. Es solo de
            // pantalla: no se guarda ni viaja al prompt, lo que cuenta es el
            // texto que deja en la caja.
            const promptW = this.widgets?.find(x => x.name === "prompt");
            if (promptW) {
                const presetW = this.addWidget("combo", "preset", "Custom", (v) => {
                    promptW.value = PRESETS[v] ?? "";
                    app.graph?.setDirtyCanvas(true, true);
                }, { values: Object.keys(PRESETS), serialize: false });
                presetW.serialize = false;
                this.widgets.splice(this.widgets.indexOf(presetW), 1);
                this.widgets.splice(this.widgets.indexOf(promptW), 0, presetW);
            }

            const box = document.createElement("div");
            box.style.cssText = "display:flex; flex-direction:column; gap:4px; width:100%; height:100%;"
                + "box-sizing:border-box; font:11px sans-serif; color:#ccc;";
            box.innerHTML = `
                <textarea class="asd-e-pos" spellcheck="false"
                    placeholder="The enhanced prompt appears here. You can edit it before sending."
                    style="flex:3 1 0; min-height:90px; ${AREA}"></textarea>
                <textarea class="asd-e-neg" spellcheck="false"
                    placeholder="The negative prompt appears here."
                    style="flex:1 1 0; min-height:40px; ${AREA}"></textarea>
                <div style="display:flex; gap:10px; align-items:center;">
                    <label title="When Enhance prompt finishes, write the prompt into the Positive node">
                        <input type="checkbox" class="asd-e-autopos"> auto Send Positive</label>
                    <label title="When Enhance prompt finishes, write the negative into the Negative node">
                        <input type="checkbox" class="asd-e-autoneg"> auto Send Negative</label>
                </div>
                <div style="display:flex; gap:4px; align-items:center;">
                    <button class="asd-e-go">&#10024; Enhance prompt</button>
                    <button class="asd-e-send">&#10148; Send prompt</button>
                    <span class="asd-e-note" style="margin-left:auto; min-width:0; overflow:hidden;
                          text-overflow:ellipsis; white-space:nowrap; color:#9aa0a6;"></span>
                </div>`;
            for (const b of box.querySelectorAll("button")) {
                b.style.cssText = "height:22px; padding:0 10px; border:1px solid #4a4a4a; border-radius:4px;"
                    + "background:#242424; color:#ddd; font-size:11px; cursor:pointer; white-space:nowrap;";
            }
            const posText = box.querySelector(".asd-e-pos");
            const negText = box.querySelector(".asd-e-neg");
            const autoPos = box.querySelector(".asd-e-autopos");
            const autoNeg = box.querySelector(".asd-e-autoneg");
            const goBtn = box.querySelector(".asd-e-go");
            const noteEl = box.querySelector(".asd-e-note");
            const note = (t) => { noteEl.textContent = t; noteEl.title = t; };

            // Los resultados y las casillas viven en properties, que se guardan
            // con el workflow. Las casillas nacen marcadas.
            const show = () => {
                posText.value = self.properties.asd_result || "";
                negText.value = self.properties.asd_negative || "";
                autoPos.checked = self.properties.asd_auto_pos !== false;
                autoNeg.checked = self.properties.asd_auto_neg !== false;
                note(self.properties.asd_ratio ? `aspect ratio ${self.properties.asd_ratio}` : "");
            };
            posText.addEventListener("input", () => { self.properties.asd_result = posText.value; });
            negText.addEventListener("input", () => { self.properties.asd_negative = negText.value; });
            autoPos.addEventListener("change", () => { self.properties.asd_auto_pos = autoPos.checked; });
            autoNeg.addEventListener("change", () => { self.properties.asd_auto_neg = autoNeg.checked; });

            // Escribe en Positive y/o Negative y dice que ha hecho.
            const send = (toPos, toNeg) => {
                const done = [];
                const positive = posText.value.trim();
                if (toPos && positive) {
                    const pos = target(POSITIVE);
                    if (pos === undefined) return "⚠ several Positive nodes: select the one to send to";
                    if (!pos) return "⚠ no Academia SD Positive node in the workflow";
                    pos.asdSetText(positive);
                    done.push("Positive");
                }
                const negative = negText.value.trim();
                if (toNeg && negative) {
                    const neg = target(NEGATIVE);
                    if (neg === undefined) return "⚠ several Negative nodes: select the one to send to";
                    if (neg) { neg.asdSetText(negative); done.push("Negative"); }
                }
                app.graph.setDirtyCanvas(true, true);
                return done.length ? `✔ sent to ${done.join(" and ")}` : "⚠ nothing to send yet";
            };
            for (const area of [posText, negText]) {
                for (const ev of ["keydown", "keyup", "wheel"]) area.addEventListener(ev, (e) => e.stopPropagation());
            }
            box.addEventListener("mousedown", (e) => e.stopPropagation());

            goBtn.addEventListener("click", async () => {
                goBtn.disabled = true;
                note("queued …");
                try {
                    const { output } = await app.graphToPrompt();
                    const id = String(self.id);
                    if (!output[id]) throw new Error("the node is bypassed or muted");
                    const prompt = upstream(output, id);
                    // Cada pulsacion es un intento nuevo: sin esto ComfyUI
                    // devolveria el resultado anterior desde su cache.
                    if (prompt[id].inputs.temperature > 0) {
                        prompt[id].inputs.seed = Math.floor(Math.random() * 2 ** 32);
                    }
                    // El negativo es una segunda ejecucion del mismo nodo, que
                    // recibe el positivo: ver el comentario en enhance().
                    prompt.enh_second = structuredClone(prompt[id]);
                    prompt.enh_second.inputs.positive = [id, 0];
                    prompt.enh_prompt = { class_type: "PreviewAny", inputs: { source: [id, 0] } };
                    prompt.enh_negative = { class_type: "PreviewAny", inputs: { source: ["enh_second", 1] } };
                    prompt.enh_ratio = { class_type: "PreviewAny", inputs: { source: [id, 2] } };
                    const outputs = await runPrompt(prompt);
                    self.properties.asd_result = outputs.enh_prompt?.text?.[0] || "";
                    self.properties.asd_negative = outputs.enh_negative?.text?.[0] || "";
                    self.properties.asd_ratio = outputs.enh_ratio?.text?.[0] || "";
                    show();
                    if (autoPos.checked || autoNeg.checked) note(send(autoPos.checked, autoNeg.checked));
                } catch (e) {
                    note(`⚠ ${e.message}`);
                } finally {
                    goBtn.disabled = false;
                }
            });

            box.querySelector(".asd-e-send").addEventListener("click", () => note(send(true, true)));

            this.addDOMWidget("enhancer", "HTML", box, { serialize: false, getMinHeight: () => 240 });
            this.asdShow = show;
            show();
        };

        // properties se restauran despues de onNodeCreated.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            if (onConfigure) onConfigure.apply(this, arguments);
            hideSockets(this);
            this.asdShow?.();
        };
    },
});
