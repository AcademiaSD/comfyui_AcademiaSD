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

app.registerExtension({
    name: "AcademiaSD.PromptEnhancer",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);
            const self = this;
            // Sin salidas en pantalla: nada puede colgar de el, y por eso un Run
            // del workflow no lo ejecuta nunca.
            for (let i = (this.outputs?.length || 0) - 1; i >= 0; i--) this.removeOutput(i);
            this.properties ??= {};

            const box = document.createElement("div");
            box.style.cssText = "display:flex; flex-direction:column; gap:4px; width:100%; height:100%;"
                + "box-sizing:border-box; font:11px sans-serif; color:#ccc;";
            box.innerHTML = `
                <textarea spellcheck="false" placeholder="The enhanced prompt appears here. You can edit it before sending."
                    style="flex:1 1 auto; min-height:60px; resize:none; box-sizing:border-box; padding:6px;
                           background:#141414; color:#ddd; border:1px solid #3d3d3d; border-radius:4px;
                           font:12px sans-serif; line-height:1.35;"></textarea>
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
            const text = box.querySelector("textarea");
            const goBtn = box.querySelector(".asd-e-go");
            const noteEl = box.querySelector(".asd-e-note");
            const note = (t) => { noteEl.textContent = t; noteEl.title = t; };

            // El resultado vive en properties, que se guardan con el workflow.
            const show = () => {
                text.value = self.properties.asd_result || "";
                note(self.properties.asd_ratio ? `aspect ratio ${self.properties.asd_ratio}` : "");
            };
            text.addEventListener("input", () => { self.properties.asd_result = text.value; });
            for (const ev of ["keydown", "keyup", "wheel"]) text.addEventListener(ev, (e) => e.stopPropagation());
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
                    prompt.enh_prompt = { class_type: "PreviewAny", inputs: { source: [id, 0] } };
                    prompt.enh_ratio = { class_type: "PreviewAny", inputs: { source: [id, 1] } };
                    const outputs = await runPrompt(prompt);
                    self.properties.asd_result = outputs.enh_prompt?.text?.[0] || "";
                    self.properties.asd_ratio = outputs.enh_ratio?.text?.[0] || "";
                    show();
                } catch (e) {
                    note(`⚠ ${e.message}`);
                } finally {
                    goBtn.disabled = false;
                }
            });

            box.querySelector(".asd-e-send").addEventListener("click", () => {
                const positive = text.value.trim();
                if (!positive) return note("⚠ nothing to send yet");
                const pos = target(POSITIVE);
                if (pos === undefined) return note("⚠ several Positive nodes: select the one to send to");
                if (!pos) return note("⚠ no Academia SD Positive node in the workflow");
                pos.asdSetText(positive);
                // El negativo solo si se ha escrito aqui: si llega por cable ya
                // esta donde tiene que estar.
                const negW = self.widgets?.find(w => w.name === "negative_prompt");
                const negLinked = self.inputs?.some(i => i.name === "negative_prompt" && i.link != null);
                const negative = negLinked ? "" : String(negW?.value || "").trim();
                const neg = negative ? target(NEGATIVE) : null;
                if (neg) neg.asdSetText(negative);
                app.graph.setDirtyCanvas(true, true);
                note(neg ? "✔ sent to Positive and Negative" : "✔ sent to Positive");
            });

            this.addDOMWidget("enhancer", "HTML", box, { serialize: false, getMinHeight: () => 180 });
            this.asdShow = show;
            show();
        };

        // properties se restauran despues de onNodeCreated.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            if (onConfigure) onConfigure.apply(this, arguments);
            for (let i = (this.outputs?.length || 0) - 1; i >= 0; i--) this.removeOutput(i);
            this.asdShow?.();
        };
    },
});
