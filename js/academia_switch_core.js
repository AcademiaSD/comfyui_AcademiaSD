// academia_switch_core.js
// Piezas compartidas por los dos nodos Academia Switch.
// Este fichero no registra ninguna extension: ComfyUI lo carga igualmente
// porque esta en WEB_DIRECTORY, y los otros dos lo importan por la misma URL,
// asi que el modulo se evalua una sola vez.

import { app } from "../../scripts/app.js";

/* ------------------------------------------------------------------ modos */

export const MODE_ALWAYS = 0;
export const MODE_MUTE   = 2;   // LiteGraph.NEVER
export const MODE_BYPASS = 4;

// Estado de una celda de la matriz. "skip" es la clave del diseno: el modo
// simplemente no opina sobre ese grupo y lo deja como este.
export const CELL_ORDER = ["skip", "on", "bypass", "mute"];

export const CELL_META = {
    skip:   { glyph: "·", label: "Ignore", cls: "asw-c-skip",
              tip: "Ignore — this mode leaves the group as it is" },
    on:     { glyph: "▶", label: "Active", cls: "asw-c-on",
              tip: "Active — all nodes in the group set to ALWAYS" },
    bypass: { glyph: "⇝", label: "Bypass", cls: "asw-c-bypass",
              tip: "Bypass — all nodes in the group set to BYPASS" },
    mute:   { glyph: "✕", label: "Mute", cls: "asw-c-mute",
              tip: "Mute — all nodes in the group set to NEVER" },
};

export function cellToNodeMode(cell) {
    if (cell === "on") return MODE_ALWAYS;
    if (cell === "bypass") return MODE_BYPASS;
    if (cell === "mute") return MODE_MUTE;
    return null;                 // skip
}

export function nodeModeToCell(mode) {
    if (mode === MODE_BYPASS) return "bypass";
    if (mode === MODE_MUTE) return "mute";
    return "on";                 // ALWAYS y cualquier otro modo raro
}

/* ------------------------------------------------------------------ utils */

let _uidCounter = 0;
export function uid(prefix = "m") {
    _uidCounter += 1;
    return prefix + Date.now().toString(36) + _uidCounter.toString(36);
}

export function graphOf(node) {
    // Con subgrafos, app.graph puede no ser el grafo donde vive el nodo.
    return node?.graph || app.graph;
}

export function redraw() {
    try { app.graph?.setDirtyCanvas(true, true); } catch (e) {}
    try { app.canvas?.setDirty(true, true); } catch (e) {}
}

/* ------------------------------------------------- tamano de widgets DOM */

// Un widget DOM declara su altura al frontend con options.getMinHeight /
// getMaxHeight (DOMWidgetImpl.computeLayoutSize). Sin ellas LiteGraph
// dimensiona el nodo como si el widget no ocupara nada y el contenido se sale
// por debajo del borde.
export function addFittedDOMWidget(node, name, element) {
    node.__asDomH = 100;
    node.__asDomMaxH = null;
    node.__asDomEl = element;
    return node.addDOMWidget(name, "HTML", element, {
        hideOnZoom: false,
        getMinHeight: () => node.__asDomH,
        getMaxHeight: () => node.__asDomMaxH ?? undefined,
    });
}

// Se mide el contenido en vez de estimarlo: fuentes y tema cambian los
// pixeles. El height:auto momentaneo es necesario porque si no se leeria la
// altura que el layout del nodo acaba de imponer y nunca podria encoger.
function measureContent(el, fallback) {
    if (!el || !el.isConnected) return fallback;
    const prev = el.style.height;
    el.style.height = "auto";
    const h = el.scrollHeight;
    el.style.height = prev;
    return h > 12 ? Math.ceil(h) + 2 : fallback;
}

/**
 * Ajusta el nodo a su contenido. El alto NO se calcula a mano: se deja que
 * computeSize() de LiteGraph sume titulo, slots de entrada/salida y widgets.
 *
 * `layoutSig` describe la forma del contenido; solo cuando cambia se vuelve a
 * encajar el nodo, de modo que un tamano puesto a mano por el usuario
 * sobrevive a las acciones que no cambian la estructura.
 */
export function fitToContent(node, minWidth, fallbackH, layoutSig, lockMax = false) {
    const contentH = measureContent(node.__asDomEl, fallbackH);
    node.__asDomH = contentH;
    node.__asDomMaxH = lockMax ? contentH : null;

    const need = node.computeSize();
    const minH = Math.ceil(need[1]);
    node.__asMin = [Math.max(minWidth, Math.ceil(need[0])), minH];

    const reflow = node.__asSig !== layoutSig;
    node.__asSig = layoutSig;

    const w = Math.max(node.size[0], node.__asMin[0]);
    let h = node.size[1];
    if (reflow || h < minH) h = minH;

    if (w !== node.size[0] || h !== node.size[1]) {
        node.setSize([w, h]);
        redraw();
    }
}

export function clampToMin(node, size) {
    const min = node.__asMin;
    if (!min) return;
    if (size[0] < min[0]) size[0] = min[0];
    if (size[1] < min[1]) size[1] = min[1];
}

/* ----------------------------------------------------------------- grupos */

export function listGroups(node) {
    const graph = graphOf(node);
    const groups = graph?.groups || graph?._groups || [];
    const out = [];
    for (const g of groups) {
        if (!g) continue;
        try { g.recomputeInsideNodes?.(); } catch (e) {}
        out.push(g);
    }
    return out;
}

export function groupNodes(group) {
    // El nombre de la propiedad ha ido cambiando entre versiones del frontend.
    const raw = group?.nodes || group?._nodes || group?.children || [];
    const out = [];
    for (const n of raw) {
        if (n && typeof n.mode === "number") out.push(n);
    }
    return out;
}

// Las claves de la matriz son titulos de grupo, no ids: sobreviven a que
// borres y rehagas el grupo, y son lo que el usuario reconoce. Si hay dos
// grupos con el mismo titulo, el modo actua sobre los dos.
export function groupKey(group) {
    return String(group?.title ?? "").trim() || "(untitled)";
}

// Estado real del grupo ahora mismo: "on" / "bypass" / "mute" / "mixed" / null.
export function liveGroupState(group) {
    const nodes = groupNodes(group);
    if (!nodes.length) return null;
    let state = null;
    for (const n of nodes) {
        const c = nodeModeToCell(n.mode);
        if (state === null) state = c;
        else if (state !== c) return "mixed";
    }
    return state;
}

export function setGroupState(group, cell) {
    const target = cellToNodeMode(cell);
    if (target === null) return 0;
    let changed = 0;
    for (const n of groupNodes(group)) {
        if (n.mode !== target) {
            n.mode = target;
            changed += 1;
        }
    }
    return changed;
}

/* ----------------------------------------------------- widgets de terceros */

export function setWidgetValue(targetNode, widgetName, value) {
    const w = targetNode?.widgets?.find((x) => x.name === widgetName);
    if (!w) return false;
    if (w.value === value) return true;
    w.value = value;
    try {
        // Muchos loaders reaccionan en el callback (refrescar otro combo, etc).
        w.callback?.(value, app.canvas, targetNode, [0, 0], {});
    } catch (e) {}
    return true;
}

export function widgetOptions(w) {
    let vals = w?.options?.values;
    if (typeof vals === "function") {
        try { vals = vals(w, null); } catch (e) { vals = null; }
    }
    return Array.isArray(vals) ? vals : null;
}

/* -------------------------------------------------------------------- bus */

// Un nodo de grupos, al cambiar de modo, avisa por aqui; los nodos de modelos
// sincronizados aplican el modo del mismo nombre. Vive en window para que
// sobreviva a recargas parciales del modulo.
export const bus = (window.__ACADEMIA_SWITCH_BUS__ = window.__ACADEMIA_SWITCH_BUS__ || {
    listeners: new Set(),
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    emit(evt) {
        for (const fn of Array.from(this.listeners)) {
            try { fn(evt); } catch (e) { console.error("[AcademiaSwitch] bus", e); }
        }
    },
});

/* ------------------------------------------------------------------ estilo */

const STYLE_ID = "academia-switch-style";

export function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.asw-root { width:100%; box-sizing:border-box; display:flex; flex-direction:column;
    gap:6px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size:11px; color:#c9d1d9; padding:2px 0; }
.asw-root * { box-sizing:border-box; }

.asw-bar { display:flex; align-items:center; gap:6px; }
.asw-bar-grow { flex:1; min-width:0; }

.asw-input { flex:1; min-width:0; padding:3px 6px; border:1px solid #444;
    background:#0d1117; color:#ddd; border-radius:4px; font-size:11px;
    outline:none; }
.asw-input:focus { border-color:#4a6ee0; }

.asw-btn { cursor:pointer; padding:3px 8px; background:rgba(255,255,255,0.05);
    color:#c9d1d9; border:1px solid #444; border-radius:5px; font-size:11px;
    white-space:nowrap; transition:background .15s, border-color .15s; }
.asw-btn:hover { background:rgba(255,255,255,0.12); border-color:#666; }
.asw-btn.asw-primary { background:#2b4bb8; border-color:#3b5fd9; color:#fff; }
.asw-btn.asw-primary:hover { background:#3358d8; }

.asw-check { display:flex; align-items:center; gap:4px; color:#8b949e;
    cursor:pointer; user-select:none; white-space:nowrap; }
.asw-check input { margin:0; cursor:pointer; }

.asw-scroll { max-height:420px; overflow-y:auto; overflow-x:auto;
    border:1px solid #30363d; border-radius:6px; background:rgba(0,0,0,0.25); }
.asw-scroll::-webkit-scrollbar { width:8px; height:8px; }
.asw-scroll::-webkit-scrollbar-thumb { background:#484f58; border-radius:4px; }

.asw-table { width:100%; border-collapse:separate; border-spacing:0; }
.asw-table th, .asw-table td { padding:0; }

.asw-th-name { text-align:left; padding:5px 8px; font-weight:600; color:#8b949e;
    font-size:10px; letter-spacing:.4px; text-transform:uppercase;
    position:sticky; left:0; background:#161b22; z-index:2; }
.asw-thead th { position:sticky; top:0; background:#161b22; z-index:3;
    border-bottom:1px solid #30363d; }

.asw-mode-h { min-width:62px; padding:3px 4px; cursor:pointer; user-select:none;
    border-left:1px solid #21262d; }
.asw-mode-h .asw-chip { display:flex; align-items:center; justify-content:center;
    gap:4px; padding:3px 6px; border-radius:5px; border:1px solid transparent;
    font-size:11px; font-weight:600; color:#8b949e; }
.asw-mode-h:hover .asw-chip { background:rgba(255,255,255,0.06); }
.asw-mode-h.asw-active .asw-chip { background:#1f3a8a33; border-color:#4a6ee0;
    color:#e6edf3; box-shadow:0 0 0 1px #4a6ee055 inset; }
.asw-mode-h .asw-dots { opacity:0; color:#6e7681; padding:0 2px; }
.asw-mode-h:hover .asw-dots { opacity:1; }

.asw-row td { border-top:1px solid #21262d; }
.asw-row:hover td { background:rgba(255,255,255,0.03); }
.asw-name { padding:3px 8px; white-space:nowrap; overflow:hidden;
    text-overflow:ellipsis; max-width:280px; position:sticky; left:0;
    background:#12171d; z-index:1; }
.asw-row:hover .asw-name { background:#171d24; }
.asw-name .asw-live { display:inline-block; width:6px; height:6px;
    border-radius:50%; margin-right:6px; vertical-align:middle;
    background:#484f58; }
.asw-live.l-on { background:#3fb950; }
.asw-live.l-bypass { background:#a371f7; }
.asw-live.l-mute { background:#f85149; }
.asw-live.l-mixed { background:#d29922; }

.asw-cell { text-align:center; cursor:pointer; user-select:none;
    border-left:1px solid #21262d; }
.asw-cell > span { display:block; margin:2px 4px; padding:2px 0;
    border-radius:4px; font-size:12px; line-height:16px;
    border:1px solid transparent; transition:background .1s; }
.asw-cell:hover > span { background:rgba(255,255,255,0.08); }
.asw-c-skip   { color:#484f58; }
.asw-c-on     { color:#3fb950; background:#3fb9501f; border-color:#3fb95055 !important; }
.asw-c-bypass { color:#c39bff; background:#a371f71f; border-color:#a371f755 !important; }
.asw-c-mute   { color:#f85149; background:#f851491f; border-color:#f8514955 !important; }

.asw-empty { padding:14px 10px; text-align:center; color:#6e7681; font-size:11px;
    line-height:1.5; }

.asw-legend { display:flex; gap:10px; color:#6e7681; font-size:10px;
    flex-wrap:wrap; padding:0 2px; }

.asw-menu { position:fixed; z-index:2000000; background:#1c2128;
    border:1px solid #444c56; border-radius:6px; padding:4px;
    box-shadow:0 8px 24px rgba(0,0,0,.6); min-width:170px;
    font-family: system-ui, sans-serif; font-size:12px; color:#c9d1d9; }
.asw-menu-item { padding:5px 10px; border-radius:4px; cursor:pointer;
    white-space:nowrap; }
.asw-menu-item:hover { background:#2b4bb8; color:#fff; }
.asw-menu-sep { height:1px; background:#30363d; margin:4px 2px; }
.asw-menu-head { padding:4px 10px; color:#6e7681; font-size:10px;
    text-transform:uppercase; letter-spacing:.5px; }

.asw-picker { position:fixed; z-index:2000000; background:#1c2128;
    border:1px solid #444c56; border-radius:8px; padding:8px;
    box-shadow:0 10px 30px rgba(0,0,0,.7); width:440px; max-width:90vw;
    font-family: system-ui, sans-serif; font-size:12px; color:#c9d1d9; }
.asw-picker .asw-plist { max-height:300px; overflow-y:auto; margin-top:6px; }
.asw-pitem { padding:5px 8px; border-radius:4px; cursor:pointer;
    display:flex; gap:8px; align-items:baseline; }
.asw-pitem:hover { background:#2b4bb8; color:#fff; }
.asw-pitem .asw-pnode { color:#8b949e; font-size:10px; }
.asw-pitem:hover .asw-pnode { color:#dbe6ff; }
.asw-pitem .asw-pcur { margin-left:auto; color:#6e7681; font-size:10px;
    max-width:150px; overflow:hidden; text-overflow:ellipsis;
    white-space:nowrap; }

.asw-sel { width:100%; padding:2px 4px; background:#0d1117; color:#ddd;
    border:1px solid #30363d; border-radius:4px; font-size:11px; outline:none; }
.asw-sel:focus { border-color:#4a6ee0; }
.asw-sel.asw-unset { color:#6e7681; font-style:italic; }

.asw-x { cursor:pointer; color:#484f58; padding:0 5px; font-size:13px; }
.asw-x:hover { color:#f85149; }
`;
    document.head.appendChild(style);
}

/* ------------------------------------------------------------ menu flotante */

export function popupMenu(x, y, items) {
    document.querySelectorAll(".asw-menu").forEach((el) => el.remove());
    const menu = document.createElement("div");
    menu.className = "asw-menu";
    for (const it of items) {
        if (it === "-") {
            const sep = document.createElement("div");
            sep.className = "asw-menu-sep";
            menu.appendChild(sep);
            continue;
        }
        if (it.head) {
            const h = document.createElement("div");
            h.className = "asw-menu-head";
            h.textContent = it.head;
            menu.appendChild(h);
            continue;
        }
        const el = document.createElement("div");
        el.className = "asw-menu-item";
        el.textContent = it.content;
        el.onclick = (e) => {
            e.stopPropagation();
            menu.remove();
            try { it.callback?.(); } catch (err) { console.error(err); }
        };
        menu.appendChild(el);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + "px";
    const close = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener("mousedown", close, true);
        }
    };
    setTimeout(() => document.addEventListener("mousedown", close, true), 0);
    return menu;
}

/* --------------------------------------------- utilidades de estado comun */

// Estructura de modos compartida por los dos nodos.
export function ensureModes(state, defaults) {
    if (!Array.isArray(state.modes) || state.modes.length === 0) {
        state.modes = (defaults || ["A", "B"]).map((name) => ({ id: uid(), name }));
    }
    if (!state.modes.find((m) => m.id === state.active)) {
        state.active = state.modes[0].id;
    }
    return state;
}

export function activeMode(state) {
    return state.modes?.find((m) => m.id === state.active) || state.modes?.[0] || null;
}

// Un prompt para renombrar sin usar el prompt() nativo bloqueante seria mas
// bonito, pero prompt() se comporta bien dentro del canvas de ComfyUI y evita
// arrastrar un dialogo propio.
export function askText(message, current) {
    const v = window.prompt(message, current ?? "");
    if (v === null) return null;
    const t = String(v).trim();
    return t.length ? t : null;
}
