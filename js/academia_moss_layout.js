import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { runPrompt } from "./academia_queue.js";
import { NEGATIVE, POSITIVE, target } from "./academia_prompt_enhancer.js";

// MOSS Layout: cajas sobre un lienzo con la proporcion de width/height, que se
// guardan en `layout_data` en fracciones 0..1. El JSON del panel es una vista
// previa calculada igual que en Python (nodes/academia_moss_layout.py).
const NODE_NAME = "AcademiaSD_MossLayout";
const LABELS = {
    text:      { color: "#ffb86b", fill: "rgba(255,184,107,.14)", name: "Text" },
    object:    { color: "#7fd3ff", fill: "rgba(127,211,255,.14)", name: "Object" },
    character: { color: "#8ef0a6", fill: "rgba(142,240,166,.14)", name: "Character" },
};
const CANVAS = ["single", "multi_panel", "collage"];
const GENERICA = { object: "An object", character: "A character", text: "Text" };
const MIN_BOX = 0.02;

const CSS = `
.asd-ml { display:flex; flex-direction:column; gap:6px; height:100%; box-sizing:border-box; padding:4px 2px;
  font:12px 'Segoe UI', system-ui, sans-serif; color:#ddd; }
.asd-ml * { box-sizing:border-box; }
.asd-ml-bar { display:flex; flex-wrap:wrap; align-items:center; gap:5px; }
.asd-ml button { background:#2b2f36; color:#ddd; border:1px solid #444; border-radius:5px; padding:3px 9px; cursor:pointer; font:inherit; }
.asd-ml button:hover { border-color:#7fd3ff; }
.asd-ml button.gen { background:#1f4a35; border-color:#3f8f58; color:#c8f7d6; font-weight:600; }
.asd-ml-sep { width:1px; height:18px; background:#444; margin:0 2px; }
.asd-ml-main { flex:1; display:flex; gap:8px; min-height:0; }
.asd-ml-stage { flex:1; position:relative; background:#0c1a2e; border:1px solid #333; border-radius:6px; min-width:0; min-height:160px; overflow:hidden; }
.asd-ml-canvas { position:absolute; background:#1a1d24; outline:1px solid #555; overflow:hidden; }
.asd-ml-canvas img { position:absolute; inset:0; width:100%; height:100%; object-fit:fill; pointer-events:none; }
.asd-ml-size { position:absolute; right:6px; bottom:4px; color:#888; font:11px Consolas, monospace; pointer-events:none; }
.asd-ml-box { position:absolute; border:2px solid; border-radius:3px; cursor:move; }
.asd-ml-box.sel { box-shadow:0 0 0 2px #fff8, 0 0 12px #fff4; }
.asd-ml-tag { position:absolute; left:0; top:0; max-width:100%; padding:1px 5px; font:600 11px 'Segoe UI', sans-serif;
  color:#111; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:none; }
.asd-ml-h { position:absolute; width:10px; height:10px; background:#fff; border:1px solid #333; border-radius:2px; }
.asd-ml-ed { display:grid; grid-template-columns:auto 1fr; gap:4px 6px; align-items:start; }
.asd-ml-ed label { color:#999; padding-top:3px; white-space:nowrap; }
.asd-ml textarea, .asd-ml input[type=text], .asd-ml select { width:100%; background:#15181d; color:#ddd; border:1px solid #3d3d3d;
  border-radius:4px; padding:3px 6px; font:inherit; resize:vertical; }
.asd-ml-right { width:36%; min-width:300px; max-width:520px; display:flex; flex-direction:column; gap:6px; min-height:0; }
.asd-ml-right textarea.json { flex:1; min-height:80px; resize:none; font:11px/1.45 Consolas, monospace; color:#8ef0a6; }
.asd-ml-hint { color:#888; font-size:11px; }
.asd-ml-status { color:#8ef0a6; font-size:11px; min-height:14px; }
.asd-ml-status.warn { color:#ffb86b; }
.asd-ml button.ana { background:#2a2550; border-color:#6a5acd; color:#d6d0ff; }
.asd-ml button:disabled { opacity:.5; cursor:wait; }
`;

function ocultarWidget(node, nombre) {
    const w = node.widgets?.find((x) => x.name === nombre);
    if (!w) return null;
    w.hidden = true;
    w.type = "hidden";
    w.computeSize = () => [0, 0];
    w.draw = function () {};
    const el = w.element || w.inputEl;
    if (el?.style) { el.style.display = "none"; el.style.visibility = "hidden"; }
    return w;
}

function lista(v) {
    return String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// La misma cuenta que _caja() en Python: [x1,y1,x2,y2] 0..1 -> [y1,x1,y2,x2] centrado.
function caja(box, w, h) {
    let [x1, y1, x2, y2] = box.map((v) => Math.min(1, Math.max(0, v)));
    [x1, x2] = [Math.min(x1, x2), Math.max(x1, x2)];
    [y1, y2] = [Math.min(y1, y2), Math.max(y1, y2)];
    const px1 = Math.floor(x1 * w), py1 = Math.floor(y1 * h);
    const px2 = Math.max(px1 + 1, Math.ceil(x2 * w)), py2 = Math.max(py1 + 1, Math.ceil(y2 * h));
    const cw = Math.floor(w / 2), ch = Math.floor(h / 2);
    return [py1 - ch, px1 - cw, py2 - ch, px2 - cw];
}

function compilar(st, w, h) {
    const s = st.summary;
    const summary = { caption: String(s.caption || "").trim() };
    if (lista(s.meta).length) summary.meta = lista(s.meta);
    if (CANVAS.includes(s.canvas)) summary.canvas = s.canvas;
    if (lista(s.palette).length) summary.palette = lista(s.palette);
    const items = [];
    for (const it of st.items) {
        const caption = String(it.caption || "").trim() || GENERICA[it.label] || GENERICA.object;
        if (it.label === "text" && !String(it.text || "").trim()) continue;
        const o = { label: it.label, caption };
        if (it.label === "text") o.text = it.text;
        if (lista(it.tags).length) o.tags = lista(it.tags);
        if (lista(it.palette).length) o.palette = lista(it.palette);
        o.bbox = caja(it.box, w, h);
        items.push(o);
    }
    if (!items.length) return summary.caption;
    return JSON.stringify({ summary, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx" });
}

function estadoVacio() {
    return { summary: { caption: "", meta: "", canvas: "single", palette: "" }, items: [], auto: true, json: "", bg_opacity: 0.6 };
}

app.registerExtension({
    name: "AcademiaSD.MossLayout",
    async setup() {
        const s = document.createElement("style");
        s.textContent = CSS;
        document.head.appendChild(s);
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const self = this;
            const dataW = ocultarWidget(this, "layout_data");
            const negW = this.widgets?.find((x) => x.name === "negative_prompt");
            if (negW?.options) { negW.options.getMinHeight = () => 44; negW.options.getMaxHeight = () => 64; }
            let st = estadoVacio();
            let sel = -1;
            let lastSize = [1024, 1024];
            let bgExec = "";

            const leer = () => {
                try { st = Object.assign(estadoVacio(), JSON.parse(dataW?.value || "{}")); }
                catch { st = estadoVacio(); }
                st.summary = Object.assign(estadoVacio().summary, st.summary || {});
                st.items = Array.isArray(st.items) ? st.items : [];
            };
            // current.json: el ultimo estado en disco, para retomarlo en un nodo nuevo otro dia.
            let tCurrent = 0;
            // Hasta que refrescar() lee el estado restaurado, st esta vacio: un encajar() del
            // ResizeObserver o del repintado no debe escribirlo encima del guardado.
            let leido = false;
            const guardar = () => {
                if (!leido) return;
                if (dataW) dataW.value = JSON.stringify(st);
                clearTimeout(tCurrent);
                tCurrent = setTimeout(() => salvar("current", st), 1000);
            };
            const salvar = (name, data) => api.fetchApi("/academia/moss_layout/save", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, data }) });
            const cargar = async (name) => {
                const res = await api.fetchApi(`/academia/moss_layout/load?name=${encodeURIComponent(name)}`);
                if (!res.ok) throw new Error(`"${name}" not found`);
                if (dataW) dataW.value = JSON.stringify(await res.json());
                refrescar();
                guardar();
            };

            // ---------- DOM ----------
            const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
            const root = el("div", "asd-ml");
            const bar = el("div", "asd-ml-bar");
            const btn = (txt, fn, cls) => { const b = el("button", cls, txt); b.onclick = fn; bar.appendChild(b); return b; };
            btn("+ Text", () => nueva("text"));
            btn("+ Object", () => nueva("object"));
            btn("+ Character", () => nueva("character"));
            bar.appendChild(el("span", "asd-ml-sep"));
            btn("Delete box", () => { if (sel >= 0) { st.items.splice(sel, 1); sel = -1; cambio(); } });
            btn("Clear", () => { if (st.items.length && confirm("Delete all boxes?")) { st.items = []; sel = -1; cambio(); } });
            bar.appendChild(el("span", "asd-ml-sep"));
            let ultimo = "";
            btn("Save JSON", async () => {
                const name = prompt("Save this layout as:", ultimo || "layout");
                if (!name) return;
                const res = await salvar(name, st);
                if (!res.ok) { aviso("⚠ Invalid name: use letters, numbers, spaces, - or _", true); return; }
                ultimo = (await res.json()).name;
                aviso(`✔ Saved as moss_layouts/${ultimo}.json`);
            }).title = "Saves the boxes, scene fields and JSON to a file in comfyui_AcademiaSD/moss_layouts.";
            btn("Load JSON", async (e) => {
                const { files } = await (await api.fetchApi("/academia/moss_layout/list")).json();
                const opciones = ["current (last state)", ...files];
                new LiteGraph.ContextMenu(opciones, { event: e, callback: async (v) => {
                    const name = v === opciones[0] ? "current" : v;
                    try { await cargar(name); if (name !== "current") ultimo = name; aviso(`✔ Loaded ${name}.json`); }
                    catch (err) { aviso(`⚠ ${err.message}`, true); }
                } });
            }).title = "Loads a saved layout, or the last state (current.json, saved automatically).";
            bar.appendChild(el("span", "asd-ml-sep"));
            bar.appendChild(el("span", null, "Background"));
            const opac = el("input");
            opac.type = "range"; opac.min = 0; opac.max = 1; opac.step = 0.05; opac.style.width = "80px";
            opac.oninput = () => { st.bg_opacity = +opac.value; bgImg.style.opacity = st.bg_opacity; guardar(); };
            bar.appendChild(opac);
            bar.appendChild(el("span", "asd-ml-sep"));
            const anaBtn = btn("Analyze Image", () => analizar(), "ana");
            anaBtn.title = "Looks at the background image with the Qwen3-VL connected to 'vlm' and places a box for each "
                + "character, object and text it finds.";
            btn("Generate JSON Prompt", () => generar(true), "gen");
            const autoL = el("label", null);
            const auto = el("input"); auto.type = "checkbox";
            auto.onchange = () => { st.auto = auto.checked; jsonTa.readOnly = st.auto; guardar(); if (st.auto) generar(true); };
            autoL.append(auto, document.createTextNode(" Auto send"));
            autoL.title = "On: the prompt is rebuilt from the boxes on every change and run, and sent to the Academia SD CLIP Text Encode "
                + "Positive (the JSON) and Negative (the negative prompt). Off: the JSON panel is used as it is (edit it by hand).";
            bar.appendChild(autoL);

            const main = el("div", "asd-ml-main");
            const stage = el("div", "asd-ml-stage");
            const cv = el("div", "asd-ml-canvas");
            const bgImg = el("img"); bgImg.style.display = "none";
            const sizeTag = el("div", "asd-ml-size");
            cv.appendChild(bgImg);
            stage.append(cv, sizeTag);

            const ed = el("div", "asd-ml-ed");
            const campo = (lbl, input) => { ed.append(el("label", null, lbl), input); return input; };
            const ta = (rows, ph) => { const t = el("textarea"); t.rows = rows; t.placeholder = ph; return t; };
            const tx = (ph) => { const t = el("input"); t.type = "text"; t.placeholder = ph; return t; };
            const gCap = campo("Scene", ta(2, "Global description of the whole image (style, setting, mood)…"));
            const gMeta = campo("Meta", tx("poster, infographic…"));
            const gRow = el("div"); gRow.style.cssText = "display:grid;grid-template-columns:110px 1fr;gap:6px;";
            const gCanvas = el("select"); CANVAS.forEach((c) => gCanvas.add(new Option(c, c)));
            const gPal = tx("palette: navy, cream…");
            gRow.append(gCanvas, gPal);
            campo("Canvas", gRow);
            const iHead = el("div", "asd-ml-hint");
            campo("Box", iHead);
            const iLabel = el("select"); Object.keys(LABELS).forEach((k) => iLabel.add(new Option(LABELS[k].name, k)));
            const iCap = ta(2, "What the box contains and how it looks…");
            const iText = ta(2, "Exact text to render (line breaks are kept)");
            const iTags = tx("tags (comma separated)");
            const iPal = tx("palette (comma separated)");
            const fLabel = campo("Type", iLabel), fCap = campo("Description", iCap);
            const fText = campo("Text", iText), fTags = campo("Tags", iTags), fPal = campo("Palette", iPal);
            const itemFields = [fLabel, fCap, fText, fTags, fPal];
            const right = el("div", "asd-ml-right");
            right.append(ed, el("div", "asd-ml-hint", "JSON prompt sent to MOSS-Image"));
            const status = el("div", "asd-ml-status");
            right.appendChild(status);
            const aviso = (txt, warn = false) => { status.textContent = txt; status.classList.toggle("warn", warn); };
            const jsonTa = el("textarea", "json"); jsonTa.spellcheck = false;
            jsonTa.placeholder = "Give each box a description (and its text, for Text boxes) and the JSON appears here.";
            jsonTa.oninput = () => { st.json = jsonTa.value; guardar(); };
            right.appendChild(jsonTa);
            main.append(stage, right);
            root.append(bar, main);

            // El canvas de ComfyUI no debe recibir los clics ni las teclas del editor.
            for (const ev of ["pointerdown", "mousedown", "wheel", "keydown", "keyup", "contextmenu"]) {
                root.addEventListener(ev, (e) => e.stopPropagation());
            }

            // ---------- tamaño ----------
            const resolver = (name) => {
                const inp = self.inputs?.find((i) => i.widget?.name === name);
                if (inp?.link != null) {
                    const link = app.graph?.links?.[inp.link];
                    const origin = link ? app.graph.getNodeById(link.origin_id) : null;
                    const outName = origin?.outputs?.[link.origin_slot]?.name || "";
                    const w = origin?.widgets?.find((x) => String(x.name).toLowerCase() === String(outName).toLowerCase());
                    const v = Math.round(Number(w?.value));
                    return Number.isFinite(v) && v > 0 ? v : null;
                }
                const v = Math.round(Number(self.widgets?.find((x) => x.name === name)?.value));
                return Number.isFinite(v) && v > 0 ? v : null;
            };
            const tamano = () => {
                const w = resolver("width"), h = resolver("height");
                return w && h ? [w, h] : lastSize;
            };
            let drawn = "";
            const encajar = () => {
                const [w, h] = tamano();
                const sw = stage.clientWidth - 12, sh = stage.clientHeight - 12;
                if (sw <= 0 || sh <= 0) return;
                const k = Math.min(sw / w, sh / h);
                cv.style.width = `${w * k}px`; cv.style.height = `${h * k}px`;
                cv.style.left = `${(stage.clientWidth - w * k) / 2}px`; cv.style.top = `${(stage.clientHeight - h * k) / 2}px`;
                sizeTag.textContent = `${w} × ${h}`;
                const key = `${w}x${h}`;
                if (key !== drawn) { drawn = key; if (st.auto) generar(false); }
            };
            new ResizeObserver(encajar).observe(stage);

            // ---------- fondo ----------
            const fondo = () => {
                const inp = self.inputs?.find((i) => i.name === "image");
                let url = "";
                if (inp?.link != null) {
                    const link = app.graph?.links?.[inp.link];
                    const origin = link ? app.graph.getNodeById(link.origin_id) : null;
                    const name = origin?.type === "LoadImage" ? origin.widgets?.find((x) => x.name === "image")?.value : null;
                    if (name) {
                        const parts = String(name).split(/[\\/]/);
                        const file = parts.pop();
                        url = api.apiURL(`/view?filename=${encodeURIComponent(file)}&type=input&subfolder=${encodeURIComponent(parts.join("/"))}`);
                    } else url = bgExec;
                }
                if (url !== bgImg.dataset.src) { bgImg.dataset.src = url; if (url) bgImg.src = url; }
                bgImg.style.display = url ? "" : "none";
                bgImg.style.opacity = st.bg_opacity;
            };

            // ---------- cajas ----------
            const pintar = () => {
                cv.querySelectorAll(".asd-ml-box").forEach((b) => b.remove());
                st.items.forEach((it, i) => {
                    const L = LABELS[it.label] || LABELS.object;
                    const [x1, y1, x2, y2] = it.box;
                    const b = el("div", "asd-ml-box" + (i === sel ? " sel" : ""));
                    Object.assign(b.style, { left: `${x1 * 100}%`, top: `${y1 * 100}%`, width: `${(x2 - x1) * 100}%`,
                        height: `${(y2 - y1) * 100}%`, borderColor: L.color, background: L.fill });
                    const t = el("div", "asd-ml-tag");
                    t.style.background = L.color;
                    const snip = (it.label === "text" ? it.text : it.caption) || "";
                    t.textContent = `#${i + 1} ${L.name}${snip ? ": " + snip.replace(/\n/g, " ") : ""}`;
                    b.appendChild(t);
                    b.onpointerdown = (e) => arrastrar(e, i, "move");
                    if (i === sel) {
                        for (const [h, cx, cy] of [["nw", 0, 0], ["ne", 1, 0], ["sw", 0, 1], ["se", 1, 1]]) {
                            const hd = el("div", "asd-ml-h");
                            Object.assign(hd.style, { left: `calc(${cx * 100}% - 6px)`, top: `calc(${cy * 100}% - 6px)`,
                                cursor: h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize" });
                            hd.onpointerdown = (e) => arrastrar(e, i, h);
                            b.appendChild(hd);
                        }
                    }
                    cv.appendChild(b);
                });
                cv.onpointerdown = (e) => { if (e.target === cv || e.target === bgImg) { sel = -1; pintar(); ficha(); } };
            };

            const arrastrar = (e, i, modo) => {
                e.stopPropagation(); e.preventDefault();
                if (sel !== i) { sel = i; pintar(); ficha(); }
                const r = cv.getBoundingClientRect();
                const ini = [...st.items[i].box], x0 = e.clientX, y0 = e.clientY;
                const mover = (ev) => {
                    const dx = (ev.clientX - x0) / r.width, dy = (ev.clientY - y0) / r.height;
                    let [x1, y1, x2, y2] = ini;
                    if (modo === "move") {
                        const w = x2 - x1, h = y2 - y1;
                        x1 = Math.min(1 - w, Math.max(0, x1 + dx)); y1 = Math.min(1 - h, Math.max(0, y1 + dy));
                        x2 = x1 + w; y2 = y1 + h;
                    } else {
                        if (modo.includes("w")) x1 = Math.min(x2 - MIN_BOX, Math.max(0, x1 + dx));
                        if (modo.includes("e")) x2 = Math.max(x1 + MIN_BOX, Math.min(1, x2 + dx));
                        if (modo.includes("n")) y1 = Math.min(y2 - MIN_BOX, Math.max(0, y1 + dy));
                        if (modo.includes("s")) y2 = Math.max(y1 + MIN_BOX, Math.min(1, y2 + dy));
                    }
                    st.items[i].box = [x1, y1, x2, y2];
                    const b = cv.querySelectorAll(".asd-ml-box")[i];
                    Object.assign(b.style, { left: `${x1 * 100}%`, top: `${y1 * 100}%`, width: `${(x2 - x1) * 100}%`, height: `${(y2 - y1) * 100}%` });
                };
                // En fase de captura: con Nodes 2.0 el WidgetDOM de Vue hace stop de
                // pointermove/pointerup y no subirian hasta window mientras el raton este en el nodo.
                const soltar = () => {
                    window.removeEventListener("pointermove", mover, true);
                    window.removeEventListener("pointerup", soltar, true);
                    window.removeEventListener("pointercancel", soltar, true);
                    cambio(false);
                };
                window.addEventListener("pointermove", mover, true);
                window.addEventListener("pointerup", soltar, true);
                window.addEventListener("pointercancel", soltar, true);
            };

            const nueva = (label) => {
                const n = st.items.length % 6;
                st.items.push({ label, caption: "", text: label === "text" ? "" : undefined, tags: "", palette: "",
                    box: [0.3 + n * 0.03, 0.3 + n * 0.03, 0.7 + n * 0.03 - 0.05, 0.5 + n * 0.03] });
                sel = st.items.length - 1;
                cambio();
                (label === "text" ? iText : iCap).focus();
            };

            // ---------- ficha ----------
            const ficha = () => {
                gCap.value = st.summary.caption; gMeta.value = st.summary.meta; gCanvas.value = st.summary.canvas; gPal.value = st.summary.palette;
                const it = st.items[sel];
                iHead.textContent = it ? `#${sel + 1} selected` : "Click a box to edit it, or add one with + Text / + Object / + Character.";
                itemFields.forEach((f) => (f.previousSibling.style.display = f.style.display = it ? "" : "none"));
                if (!it) return;
                iLabel.value = it.label; iCap.value = it.caption || ""; iText.value = it.text || "";
                iTags.value = it.tags || ""; iPal.value = it.palette || "";
                fText.style.display = fText.previousSibling.style.display = it.label === "text" ? "" : "none";
            };
            const enlazar = (input, fn) => input.addEventListener("input", () => { fn(input.value); cambio(false); });
            enlazar(gCap, (v) => (st.summary.caption = v));
            enlazar(gMeta, (v) => (st.summary.meta = v));
            gCanvas.onchange = () => { st.summary.canvas = gCanvas.value; cambio(false); };
            enlazar(gPal, (v) => (st.summary.palette = v));
            iLabel.onchange = () => { st.items[sel].label = iLabel.value; cambio(); };
            enlazar(iCap, (v) => (st.items[sel].caption = v));
            enlazar(iText, (v) => (st.items[sel].text = v));
            enlazar(iTags, (v) => (st.items[sel].tags = v));
            enlazar(iPal, (v) => (st.items[sel].palette = v));

            // ---------- JSON ----------
            const generar = (forzar) => {
                if (!st.auto && !forzar) return;
                const [w, h] = tamano();
                const txt = compilar(st, w, h);
                if (forzar) {
                    const sinTexto = st.items.filter((it) => it.label === "text" && !String(it.text || "").trim()).length;
                    aviso(!st.items.length ? "No boxes yet: add one with + Text / + Object / + Character, or Analyze Image."
                        : sinTexto ? `✔ JSON for ${w}×${h} · ${sinTexto} text box(es) without text left out`
                        : `✔ JSON for ${w}×${h} · ${st.items.length} box(es)`, !st.items.length || sinTexto > 0);
                    jsonTa.animate([{ background: "#1f4a35" }, { background: "#15181d" }], { duration: 600 });
                }
                try { jsonTa.value = txt.startsWith("{") ? JSON.stringify(JSON.parse(txt), null, 2) : txt; }
                catch { jsonTa.value = txt; }
                st.json = txt;
                guardar();
                const hechos = enviar(forzar);
                if (hechos.length) aviso(forzar ? `${status.textContent} · sent to ${hechos.join(" and ")}`
                    : `✔ sent to ${hechos.join(" and ")}`);
            };

            // Auto send: el JSON va al Positive y el negativo al Negative de Academia SD,
            // como en el Prompt Enhancer. Solo lo que ha cambiado (o todo con Generate),
            // para no reescribirlos al abrir el workflow.
            let enviado = null, enviadoNeg = null;
            const enviar = (todo = false) => {
                if (!st.auto || !leido) return [];
                const neg = String(negW?.value ?? "");
                const pos = target(POSITIVE), negNode = target(NEGATIVE);
                if (pos === undefined || negNode === undefined) {
                    aviso("⚠ several Positive/Negative nodes: select the one to send to", true);
                    return [];
                }
                const hechos = [];
                if (pos && (todo || st.json !== enviado)) { pos.asdSetText(st.json); hechos.push("Positive"); }
                if (negNode && (todo || neg !== enviadoNeg)) { negNode.asdSetText(neg); hechos.push("Negative"); }
                enviado = st.json; enviadoNeg = neg;
                if (hechos.length) app.graph.setDirtyCanvas(true, true);
                return hechos;
            };
            (negW?.element || negW?.inputEl)?.addEventListener("input", () => {
                const hechos = enviar();
                if (hechos.length) aviso(`✔ sent to ${hechos.join(" and ")}`);
            });

            const origen = (output, id, name) => {
                const v = output[id]?.inputs?.[name];
                return Array.isArray(v) ? v : null;
            };
            // Los nodos de los que depende un enlace, para encolar solo eso.
            const aguasArriba = (output, enlaces) => {
                const prompt = {}, pend = enlaces.map((l) => String(l[0]));
                while (pend.length) {
                    const id = pend.pop();
                    if (prompt[id] || !output[id]) continue;
                    prompt[id] = structuredClone(output[id]);
                    for (const v of Object.values(output[id].inputs || {})) if (Array.isArray(v)) pend.push(String(v[0]));
                }
                return prompt;
            };
            const analizar = async () => {
                anaBtn.disabled = true;
                try {
                    const { output } = await app.graphToPrompt();
                    const id = String(self.id);
                    if (!output[id]) throw new Error("the node is bypassed or muted");
                    const img = origen(output, id, "image"), vlm = origen(output, id, "vlm");
                    if (!img) throw new Error("connect an image to analyze");
                    if (!vlm) throw new Error("connect a Qwen3-VL to 'vlm' (Load CLIP, like in the Prompt Enhancer)");
                    aviso("Analyzing the image …");
                    const prompt = aguasArriba(output, [img, vlm]);
                    prompt.moss_analyze = { class_type: "AcademiaSD_MossLayoutAnalyze",
                        inputs: { vlm, image: img } };
                    const outputs = await runPrompt(prompt);
                    const res = JSON.parse(outputs.moss_analyze?.moss_layout_analysis?.[0] || "{}");
                    const nuevas = (res.items || []).map((it) => ({ label: it.label, caption: it.caption || "",
                        text: it.label === "text" ? it.text || "" : undefined, tags: "", palette: "", box: it.box }));
                    if (!nuevas.length) { aviso("⚠ The model found nothing to place.", true); return; }
                    const reemplazar = !st.items.length || confirm(`Replace the ${st.items.length} current box(es) with the `
                        + `${nuevas.length} found? (Cancel adds them)`);
                    st.items = reemplazar ? nuevas : st.items.concat(nuevas);
                    if (res.caption && (reemplazar || !st.summary.caption.trim())) st.summary.caption = res.caption;
                    sel = -1;
                    cambio();
                    generar(true);
                    aviso(`✔ ${nuevas.length} box(es) placed from the image`);
                } catch (e) {
                    aviso(`⚠ ${e.message}`, true);
                } finally {
                    anaBtn.disabled = false;
                }
            };

            // repintar = las cajas cambian de numero o de tipo; si no, solo se guarda.
            const cambio = (repintar = true) => {
                if (repintar) { pintar(); ficha(); } else pintar();
                if (st.auto) generar(false); else guardar();
            };

            const refrescar = () => {
                leer();
                leido = true;
                enviado = st.json; enviadoNeg = String(negW?.value ?? "");
                opac.value = st.bg_opacity; auto.checked = st.auto; jsonTa.readOnly = st.auto;
                jsonTa.value = st.json && st.json.startsWith("{") ? (() => { try { return JSON.stringify(JSON.parse(st.json), null, 2); } catch { return st.json; } })() : st.json;
                sel = -1; pintar(); ficha(); fondo(); encajar();
            };
            this.asdMossRefresh = refrescar;
            this.asdMossExec = (msg) => {
                const info = msg?.moss_layout?.[0];
                if (info) lastSize = [info.width, info.height];
                const bg = msg?.moss_layout_bg?.[0];
                if (bg) bgExec = api.apiURL(`/view?filename=${encodeURIComponent(bg.filename)}&type=${bg.type}&subfolder=${encodeURIComponent(bg.subfolder || "")}&t=${Date.now()}`);
                fondo(); encajar();
            };

            // Ancho/alto que llegan de otro nodo (Resolution Calc avisa con este evento) o
            // se cambian en este: comparar dos numeros por repintado no cuesta nada.
            const onSizes = () => { encajar(); fondo(); };
            window.addEventListener("academia:sizes-changed", onSizes);
            const onRemoved = this.onRemoved;
            this.onRemoved = function () { window.removeEventListener("academia:sizes-changed", onSizes); onRemoved?.apply(this, arguments); };
            const onDraw = this.onDrawForeground;
            // En cada repintado: el tamano y la imagen del Load Image pueden cambiar sin
            // evento propio (Save & Send cambia su widget). fondo() solo carga si cambia la URL.
            this.onDrawForeground = function () { onDraw?.apply(this, arguments); const [w, h] = tamano(); if (`${w}x${h}` !== drawn) encajar(); fondo(); };
            const onConn = this.onConnectionsChange;
            this.onConnectionsChange = function () { const r2 = onConn?.apply(this, arguments); setTimeout(() => { fondo(); encajar(); }, 0); return r2; };

            this.addDOMWidget("editor", "moss_layout", root, { getMinHeight: () => 420, serialize: false });
            this.setSize([Math.max(this.size[0], 900), Math.max(this.size[1], 680)]);
            // Nodo nuevo (no viene de un workflow): sigue donde se dejo, con current.json.
            setTimeout(() => {
                refrescar();
                if (!self.asdMossConfigured && !st.items.length) cargar("current").catch(() => {});
            }, 0);
            return r;
        };

        // Los widgets guardados llegan despues de onNodeCreated: se relee el estado.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this.asdMossConfigured = true;
            setTimeout(() => this.asdMossRefresh?.(), 0);
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            this.asdMossExec?.(message);
        };
    },
});
