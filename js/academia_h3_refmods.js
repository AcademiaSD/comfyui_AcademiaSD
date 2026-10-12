// academia_h3_refmods.js
// Panel del nodo AcademiaSD H3 RefMod Character: la primera imagen del sujeto
// y, debajo, los tokens que el personaje anade a la secuencia del DiT y el total
// de la cadena hasta este nodo. Los datos llegan al ejecutar el nodo, en las
// claves "asd_preview" y "asd_tokens" del mensaje de ComfyUI.
//
// Panel for the Character node: the subject's first picture and, under it, the
// DiT reference tokens of this character and the chain total so far.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { addFittedDOMWidget, fitToContent, clampToMin } from "./academia_switch_core.js";

const T_CHARACTER = "AcademiaSD_H3RefModCharacter";
const STYLE_ID = "academia-h3-refmods-style";

function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
.ahr-root { width:100%; box-sizing:border-box; display:flex; flex-direction:column; gap:6px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size:11px; color:#c9d1d9;
    padding:2px 0; }
.ahr-img { width:100%; max-height:300px; object-fit:contain; border-radius:6px;
    background:rgba(0,0,0,.25); display:none; }
.ahr-panel { border:1px solid #30363d; border-radius:6px; background:rgba(0,0,0,.25);
    padding:5px 8px; display:flex; flex-direction:column; gap:2px; }
.ahr-row { display:flex; align-items:baseline; gap:6px; white-space:nowrap; }
.ahr-k { color:#8b949e; min-width:64px; }
.ahr-v { font-weight:700; color:#e6edf3; font-variant-numeric: tabular-nums; }
.ahr-d { color:#6e7681; overflow:hidden; text-overflow:ellipsis; }
.ahr-row.total .ahr-v { color:#3fb950; }
.ahr-row.chain { border-top:1px solid #21262d; margin-top:2px; padding-top:3px; }
.ahr-row.chain .ahr-v { color:#58a6ff; }
.ahr-warn { color:#d29922; }
.ahr-off { color:#6e7681; }
.ahr-empty { color:#6e7681; text-align:center; padding:2px 0; }
`;
    document.head.appendChild(s);
}

const fmt = (n) => Number(n || 0).toLocaleString("es-ES");

function row(cls, key, value, detail) {
    const r = document.createElement("div");
    r.className = "ahr-row" + (cls ? " " + cls : "");
    const k = document.createElement("span");
    k.className = "ahr-k";
    k.textContent = key;
    const v = document.createElement("span");
    v.className = "ahr-v";
    v.textContent = value;
    r.append(k, v);
    if (detail) {
        const d = document.createElement("span");
        d.className = "ahr-d";
        d.textContent = detail;
        r.appendChild(d);
    }
    return r;
}

function renderTokens(node) {
    const panel = node.ahrEls.panel;
    const t = node.properties?.ahr_tokens;
    panel.textContent = "";
    if (!t) {
        const e = document.createElement("div");
        e.className = "ahr-empty";
        e.textContent = "Run the workflow to see the tokens · ejecuta para ver los tokens";
        panel.appendChild(e);
        return;
    }
    if (t.frames) {
        const pics = t.pictures ? "stored pictures" : "VAE decode";
        const r = row("", "🎞 Visual", t.visual ? `${fmt(t.visual)} tok` : "off",
                      `${t.frames} fr · ${t.size} · ${pics}`);
        if (!t.visual) r.querySelector(".ahr-v").classList.add("ahr-off");
        if (!t.pictures) r.querySelector(".ahr-d").classList.add("ahr-warn");
        panel.appendChild(r);
    }
    if (t.seconds !== undefined) {
        const r = row("", "🔊 Audio", t.audio ? `${fmt(t.audio)} tok` : "off", `${t.seconds} s`);
        if (!t.audio) r.querySelector(".ahr-v").classList.add("ahr-off");
        panel.appendChild(r);
    }
    panel.appendChild(row("total", "Σ " + (t.name || "Subject"), `${fmt(t.total)} tok`));
    panel.appendChild(row("chain", `Σ chain 1–${t.index}`, `${fmt(t.chain)} tok`,
                          "→ Encode"));
}

function showPreview(node) {
    const img = node.ahrEls.img;
    const p = node.properties?.ahr_preview;
    if (!p?.filename) {
        img.style.display = "none";
        img.removeAttribute("src");
        fit(node);
        return;
    }
    const q = new URLSearchParams({ filename: p.filename, type: p.type || "temp",
                                    subfolder: p.subfolder || "" });
    img.onload = () => { img.style.display = "block"; fit(node); };
    // Los temporales se borran al reiniciar ComfyUI: sin imagen, solo panel.
    img.onerror = () => { img.style.display = "none"; fit(node); };
    img.src = api.apiURL("/view?" + q.toString());
}

function fit(node) {
    fitToContent(node, 320, 90, "ahr:" + (node.ahrEls.img.style.display || "") +
                 ":" + node.ahrEls.panel.childElementCount, false);
}

app.registerExtension({
    name: "AcademiaSD.H3RefModCharacter",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== T_CHARACTER) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            injectStyle();
            const node = this;
            node.properties = node.properties || {};
            const root = document.createElement("div");
            root.className = "ahr-root";
            const img = document.createElement("img");
            img.className = "ahr-img";
            const panel = document.createElement("div");
            panel.className = "ahr-panel";
            root.append(img, panel);
            node.ahrEls = { root, img, panel };
            addFittedDOMWidget(node, "ahr_panel", root);
            const onResize = node.onResize;
            node.onResize = function (size) {
                onResize?.apply(this, arguments);
                clampToMin(node, size);
            };
            setTimeout(() => { renderTokens(node); showPreview(node); }, 60);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            const node = this;
            setTimeout(() => { if (node.ahrEls) { renderTokens(node); showPreview(node); } }, 120);
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            if (!this.ahrEls) return;
            this.properties = this.properties || {};
            this.properties.ahr_tokens = message?.asd_tokens?.[0] || null;
            this.properties.ahr_preview = message?.asd_preview?.[0] || null;
            renderTokens(this);
            showPreview(this);
        };
    },
});
