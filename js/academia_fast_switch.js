// academia_fast_switch.js
// Academia SD Fast Switch: el interruptor fisico A/B y su nodo de modelos.
//
//   Toggle  → mueve la palanca, enciende los grupos de un lado y pasa por
//             bypass los del otro. Cada Toggle es INDEPENDIENTE: manda sobre
//             sus propios grupos y sobre los nodos Models enlazados a el, y
//             nunca sobre otro Toggle ni sobre los seguidores de otro.
//   Models  → dos ranuras del mismo directorio. La activa se pinta en VERDE,
//             la dormida en ROJO, y es la activa la que sale por la salida.
//             Sigue al Toggle que elijas (o a ninguno), sin necesidad de cable.
//
// El enlace tambien funciona al reves: pulsar una ranura de un Models enlazado
// le pide el cambio a SU Toggle, que aplica sus grupos y avisa a sus seguidores.

import { app } from "../../scripts/app.js";
import {
    uid, redraw, graphOf, listGroups, groupKey, liveGroupState, setGroupState,
    bus, popupMenu, askText, injectStyle as injectCoreStyle,
    addFittedDOMWidget, fitToContent, clampToMin,
} from "./academia_switch_core.js";

const T_MODELS = "Academia_Fast_Switch_Models";
const T_TOGGLE = "Academia_Fast_Switch_Toggle";

const DEFAULT_FOLDER = "models/diffusion_models";

/* ------------------------------------------------------------------ estilo */

const STYLE_ID = "academia-fast-switch-style";

function injectStyle() {
    injectCoreStyle();                     // menus y popups compartidos
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
.afs-root { width:100%; box-sizing:border-box; display:flex; flex-direction:column;
    gap:5px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size:11px; color:#c9d1d9; padding:2px 0; }
.afs-root * { box-sizing:border-box; }

/* ------- interruptor ------- */
.afs-switch { display:flex; align-items:center; justify-content:center; gap:12px;
    padding:2px 4px; }
.afs-lab { font-weight:700; font-size:12px; letter-spacing:.2px; cursor:pointer;
    user-select:none; padding:2px 5px; border-radius:4px; flex:1; min-width:0;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    transition:color .16s, text-shadow .16s; }
.afs-lab-a { text-align:right; }
.afs-lab-b { text-align:left; }
.afs-lab.on  { color:#3fb950; text-shadow:0 0 10px rgba(63,185,80,.45); }
.afs-lab.off { color:#f85149; opacity:.55; }
.afs-lab:hover { background:rgba(255,255,255,0.06); }
.afs-lab input { width:100%; background:#0d1117; border:1px solid #4a6ee0; color:#e6edf3;
    font:inherit; font-weight:700; border-radius:4px; padding:1px 4px; outline:none;
    text-align:inherit; }

.afs-track { position:relative; width:66px; height:28px; flex:none; border-radius:15px;
    background:#080b0f; border:1px solid #30363d; cursor:pointer;
    box-shadow: inset 0 2px 6px rgba(0,0,0,.9); touch-action:none;
    transition: box-shadow .16s, border-color .16s; }
.afs-track.side-a { border-color:#3fb95055; box-shadow: inset 0 2px 6px rgba(0,0,0,.9), inset 14px 0 14px -10px rgba(63,185,80,.55); }
.afs-track.side-b { border-color:#3fb95055; box-shadow: inset 0 2px 6px rgba(0,0,0,.9), inset -14px 0 14px -10px rgba(63,185,80,.55); }
.afs-knob { position:absolute; top:3px; left:3px; width:20px; height:20px;
    border-radius:50%; background:linear-gradient(#f0f6fc,#8b949e);
    box-shadow:0 2px 4px rgba(0,0,0,.75), inset 0 -2px 3px rgba(0,0,0,.25);
    transition:left .17s cubic-bezier(.34,1.5,.5,1); }
.afs-track.side-b .afs-knob { left:41px; }
.afs-track.dragging .afs-knob { transition:none; cursor:grabbing; }

/* ------- barra de grupos ------- */
.afs-meta { display:flex; align-items:center; gap:6px; color:#8b949e; font-size:10px; }
.afs-meta .afs-toggle-panel { cursor:pointer; user-select:none; flex:1; min-width:0;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:2px 4px;
    border-radius:4px; }
.afs-meta .afs-toggle-panel:hover { background:rgba(255,255,255,0.06); color:#c9d1d9; }
.afs-gear { cursor:pointer; padding:1px 5px; border-radius:4px; color:#8b949e; }
.afs-gear:hover { background:rgba(255,255,255,0.08); color:#e6edf3; }

.afs-panel { display:flex; flex-direction:column; gap:4px; }
.afs-panel-bar { display:flex; gap:5px; align-items:center; }
.afs-list { border:1px solid #30363d; border-radius:6px; background:rgba(0,0,0,.25);
    overflow-y:auto; }
.afs-list::-webkit-scrollbar { width:8px; }
.afs-list::-webkit-scrollbar-thumb { background:#484f58; border-radius:4px; }

.afs-grow { display:flex; align-items:center; gap:6px; padding:2px 6px;
    border-bottom:1px solid #21262d; }
.afs-grow:last-child { border-bottom:none; }
.afs-grow:hover { background:rgba(255,255,255,0.03); }
.afs-gname { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
    white-space:nowrap; }
.afs-live { display:inline-block; width:6px; height:6px; border-radius:50%;
    margin-right:5px; vertical-align:middle; background:#484f58; flex:none; }
.afs-live.l-on { background:#3fb950; }
.afs-live.l-bypass { background:#a371f7; }
.afs-live.l-mute { background:#f85149; }
.afs-live.l-mixed { background:#d29922; }

.afs-seg { display:flex; flex:none; border:1px solid #30363d; border-radius:5px;
    overflow:hidden; }
.afs-seg button { border:none; background:transparent; color:#6e7681; cursor:pointer;
    font:inherit; font-weight:700; padding:1px 7px; line-height:15px; }
.afs-seg button:hover { background:rgba(255,255,255,0.08); color:#c9d1d9; }
.afs-seg button.sel-a { background:#3fb95033; color:#3fb950; }
.afs-seg button.sel-b { background:#3fb95033; color:#3fb950; }
.afs-seg button.sel-off { background:rgba(255,255,255,0.06); color:#c9d1d9; }

/* ------- nodo de modelos ------- */
.afs-folder { display:flex; align-items:center; gap:5px; color:#6e7681; font-size:10px; }
.afs-folder .afs-path { flex:1; min-width:0; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; cursor:pointer;
    padding:1px 4px; border-radius:4px; }
.afs-folder .afs-path:hover { background:rgba(255,255,255,0.06); color:#c9d1d9; }

.afs-slot { display:flex; align-items:center; gap:7px; padding:5px 7px;
    border:1px solid #30363d; border-left-width:4px; border-radius:6px;
    background:rgba(0,0,0,.28); transition:border-color .16s, background .16s, opacity .16s; }
.afs-slot.on  { border-color:#3fb95055; border-left-color:#3fb950;
                background:rgba(63,185,80,.07); }
.afs-slot.off { border-color:#f8514933; border-left-color:#f85149; opacity:.65; }
.afs-slot.off:hover { opacity:.85; }

.afs-dot { width:13px; height:13px; flex:none; border-radius:50%; cursor:pointer;
    border:2px solid #484f58; background:transparent; padding:0; }
.afs-slot.on  .afs-dot { border-color:#3fb950; background:#3fb950;
                         box-shadow:0 0 8px rgba(63,185,80,.6); }
.afs-slot.off .afs-dot { border-color:#f85149; }
.afs-slot.off .afs-dot:hover { background:#f8514955; }

.afs-name { width:88px; flex:none; font-weight:700; font-size:11px; cursor:pointer;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:2px 3px;
    border-radius:4px; }
.afs-slot.on  .afs-name { color:#3fb950; }
.afs-slot.off .afs-name { color:#f85149; }
.afs-name:hover { background:rgba(255,255,255,0.07); }
.afs-name input { width:100%; background:#0d1117; border:1px solid #4a6ee0;
    color:#e6edf3; font:inherit; font-weight:700; border-radius:3px; padding:0 3px;
    outline:none; }

.afs-file { flex:1; min-width:0; padding:2px 4px; background:#0d1117; color:#ddd;
    border:1px solid #30363d; border-radius:4px; font-size:11px; outline:none; }
.afs-file:focus { border-color:#4a6ee0; }
.afs-slot.on .afs-file { border-color:#3fb95055; }
.afs-file.missing { border-color:#f85149; color:#f85149; }

.afs-linkinfo { flex:none; font-size:10px; padding:1px 4px; border-radius:4px;
    background:rgba(255,255,255,0.05); }
.afs-linkchip { flex:none; font-size:10px; padding:1px 5px; border-radius:4px;
    cursor:pointer; background:rgba(255,255,255,0.05); color:#8b949e; }
.afs-linkchip:hover { background:rgba(255,255,255,0.12); color:#e6edf3; }
.afs-linkchip.none { color:#6e7681; }
.afs-linkchip.broken { color:#f85149; background:rgba(248,81,73,.12); }

.afs-err { color:#f85149; font-size:10px; padding:0 2px; }
.afs-hint { color:#6e7681; font-size:10px; text-align:center; padding:8px 4px;
    line-height:1.5; }
`;
    document.head.appendChild(s);
}

/* -------------------------------------------------------------- utilidades */

function labelOf(state, side) {
    return String(state.labels?.[side] || side.toUpperCase());
}

// Convierte un <span> en un campo de texto para renombrar en el sitio.
function editInline(span, current, onDone) {
    if (span.querySelector("input")) return;
    const prev = span.textContent;
    span.textContent = "";
    const inp = document.createElement("input");
    inp.value = current;
    span.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        span.textContent = prev;
        if (commit && v) onDone(v);
    };
    inp.onblur = () => finish(true);
    inp.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    inp.onmousedown = (e) => e.stopPropagation();
}

// Un clic simple selecciona y uno doble renombra; sin esto el doble clic
// dispararia antes los dos clics sueltos y el lado iria y volveria.
function clickOrDouble(el, onClick, onDouble) {
    let timer = null;
    el.onclick = () => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; onClick(); }, 210);
    };
    el.ondblclick = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        onDouble();
    };
}

/* ------------------------------------------------------------------- bus */

// Cada Toggle es su propio canal, identificado por su id de nodo, y un nodo
// Models guarda a que canal sigue. Un evento solo lo atiende quien esta
// enlazado a ESE Toggle: dos interruptores en el mismo grafo no se pisan, cada
// uno manda sobre sus propios grupos y sobre sus propios seguidores.
//
// `type:"afs"` para no pisar los eventos del switch de matriz, que escucha
// `type:"mode"`.
function emit(node, payload) {
    bus.emit(Object.assign({ type: "afs", src: node.afsUid, graph: graphOf(node) }, payload));
}

function listenBus(node, handler) {
    return bus.on((evt) => {
        if (evt?.type !== "afs") return;
        if (evt.src === node.afsUid) return;              // eco propio
        if (evt.graph && evt.graph !== graphOf(node)) return;
        handler(evt);
    });
}

/* --- lado del Toggle --- */

function channelOf(toggleNode) {
    return String(toggleNode.id);
}

function pushSide(node) {
    emit(node, { kind: "side", from: channelOf(node), side: node.afsState.side });
}

function pushLabels(node) {
    if (!node.afsState.opts.shareLabels) return;
    emit(node, { kind: "labels", from: channelOf(node), labels: node.afsState.labels });
}

// Renombrar en un Models enlazado que adopta etiquetas duraria hasta el
// siguiente empujon del Toggle. Se renombra donde vive el nombre de verdad.
function renameModelsLabel(node, side, value) {
    const t = node.afsState.opts.shareLabels ? linkedToggle(node) : null;
    if (t) {
        t.afsState.labels[side] = value;
        t.afsSync();
        t.afsRender();
        pushLabels(t);
    } else {
        node.afsState.labels[side] = value;
        node.afsSync();
    }
    node.afsRender();
}

function followerCount(node) {
    const ch = channelOf(node);
    const graph = graphOf(node);
    let n = 0;
    for (const other of graph?._nodes || graph?.nodes || []) {
        if (other.type === T_MODELS && other.afsState?.link === ch) n += 1;
    }
    return n;
}

/* --- lado del Models --- */

function toggleNodes(node) {
    const graph = graphOf(node);
    return (graph?._nodes || graph?.nodes || []).filter((n) => n.type === T_TOGGLE);
}

function modelsNodes(node) {
    const graph = graphOf(node);
    return (graph?._nodes || graph?.nodes || []).filter((n) => n.type === T_MODELS);
}

// Un id de nodo no le dice nada a nadie; las etiquetas si.
function toggleTitle(t) {
    const st = t.afsState;
    const labels = st ? ` · ${labelOf(st, "a")}/${labelOf(st, "b")}` : "";
    return `#${t.id} ${t.title || "Fast Switch Toggle"}${labels}`;
}

function goToNode(n) {
    try {
        app.canvas.centerOnNode(n);
        app.canvas.selectNode?.(n);
        redraw();
    } catch (e) {}
}

// Engancha un Models a un Toggle y lo pone al dia de una vez.
function linkModelsTo(modelsNode, toggle) {
    const st = modelsNode.afsState;
    st.link = toggle ? channelOf(toggle) : "";
    modelsNode.afsSync();
    if (toggle) {
        setModelsSide(modelsNode, toggle.afsState?.side || "a", { relay: false });
        if (st.opts.shareLabels && toggle.afsState?.labels) {
            adoptLabels(modelsNode, toggle.afsState.labels);
        }
        toggle.afsRender();
    }
    modelsNode.afsRender();
}

function linkedToggle(node) {
    const ch = node.afsState?.link;
    if (!ch) return null;
    return toggleNodes(node).find((t) => channelOf(t) === ch) || null;
}

function adoptLabels(node, labels) {
    if (!node.afsState?.opts?.shareLabels) return;
    node.afsState.labels = { a: labels.a, b: labels.b };
    node.afsSync();
    node.afsRender();
}

/* ================================================================== TOGGLE */

function toggleDefaults() {
    return {
        side: "a",
        labels: { a: "A", b: "B" },
        groups: {},                       // { titulo: "a" | "b" }  (ausente = no se toca)
        collapsed: true,
        opts: { off: "bypass", applyOnLoad: false, shareLabels: true },
    };
}

function normalizeToggle(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const d = toggleDefaults();
    s.side = s.side === "b" ? "b" : "a";
    s.labels = { a: s.labels?.a || d.labels.a, b: s.labels?.b || d.labels.b };
    s.groups = s.groups && typeof s.groups === "object" ? s.groups : {};
    s.collapsed = s.collapsed !== false;
    s.opts = Object.assign({}, d.opts, s.opts || {});
    return s;
}

function applyGroups(node) {
    const st = node.afsState;
    const off = st.opts.off === "mute" ? "mute" : "bypass";
    let touched = 0, on = 0, offCount = 0;
    for (const g of listGroups(node)) {
        const mark = st.groups[groupKey(g)];
        if (mark !== "a" && mark !== "b") continue;
        const wanted = mark === st.side ? "on" : off;
        if (wanted === "on") on += 1; else offCount += 1;
        touched += setGroupState(g, wanted);
    }
    redraw();
    console.log(`[Fast Switch] ${labelOf(st, st.side)}: ${on} group(s) on, ` +
                `${offCount} ${off}, ${touched} node(s) changed`);
}

function setToggleSide(node, side) {
    const st = node.afsState;
    st.side = side === "b" ? "b" : "a";
    applyGroups(node);
    node.afsSync();
    node.afsRender();
    pushSide(node);
}

function captureToggle(node) {
    const st = node.afsState;
    const other = st.side === "a" ? "b" : "a";
    let n = 0;
    for (const g of listGroups(node)) {
        const live = liveGroupState(g);
        if (!live || live === "mixed") continue;
        st.groups[groupKey(g)] = live === "on" ? st.side : other;
        n += 1;
    }
    node.afsSync();
    node.afsRender();
    console.log(`[Fast Switch] captured ${n} group(s)`);
}

function buildTrack(node, onSide) {
    const track = document.createElement("div");
    track.className = "afs-track";
    const knob = document.createElement("div");
    knob.className = "afs-knob";
    track.appendChild(knob);

    // Palanca de verdad: se puede arrastrar, y un clic seco tambien la mueve.
    let dragging = false, startX = 0, moved = 0, side = "a";
    const KNOB_A = 3, KNOB_B = 41;

    track.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        dragging = true;
        moved = 0;
        startX = e.clientX;
        side = node.afsState.side;
        track.classList.add("dragging");
        try { track.setPointerCapture(e.pointerId); } catch (err) {}
    });
    track.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        moved = Math.max(moved, Math.abs(e.clientX - startX));
        const base = side === "b" ? KNOB_B : KNOB_A;
        const x = Math.max(KNOB_A, Math.min(KNOB_B, base + (e.clientX - startX)));
        knob.style.left = x + "px";
    });
    const end = (e) => {
        if (!dragging) return;
        dragging = false;
        track.classList.remove("dragging");
        knob.style.left = "";
        let next;
        if (moved < 4) {
            next = side === "a" ? "b" : "a";                    // clic seco: alterna
        } else {
            const base = side === "b" ? KNOB_B : KNOB_A;
            const x = Math.max(KNOB_A, Math.min(KNOB_B, base + (e.clientX - startX)));
            next = x > (KNOB_A + KNOB_B) / 2 ? "b" : "a";       // suelta: manda donde cae
        }
        onSide(next);
    };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", () => { dragging = false; track.classList.remove("dragging"); knob.style.left = ""; });

    return track;
}

function buildToggleUI(node) {
    injectStyle();
    const root = document.createElement("div");
    root.className = "afs-root";

    /* interruptor */
    const sw = document.createElement("div");
    sw.className = "afs-switch";
    const labA = document.createElement("div");
    labA.className = "afs-lab afs-lab-a";
    const labB = document.createElement("div");
    labB.className = "afs-lab afs-lab-b";
    const track = buildTrack(node, (side) => setToggleSide(node, side));

    const renameLabel = (side, el) => {
        editInline(el, labelOf(node.afsState, side), (v) => {
            node.afsState.labels[side] = v;
            node.afsSync();
            pushLabels(node);
            node.afsRender();
        });
    };
    clickOrDouble(labA, () => setToggleSide(node, "a"), () => renameLabel("a", labA));
    clickOrDouble(labB, () => setToggleSide(node, "b"), () => renameLabel("b", labB));
    labA.title = labB.title = "Click: switch to this side · double click: rename";

    sw.append(labA, track, labB);
    root.appendChild(sw);

    /* barra de grupos */
    const meta = document.createElement("div");
    meta.className = "afs-meta";
    const panelToggle = document.createElement("div");
    panelToggle.className = "afs-toggle-panel";
    panelToggle.onclick = () => {
        node.afsState.collapsed = !node.afsState.collapsed;
        node.afsSync();
        node.afsRender();
    };
    const linkInfo = document.createElement("span");
    linkInfo.className = "afs-linkinfo";
    const gear = document.createElement("div");
    gear.className = "afs-gear";
    gear.textContent = "⚙";
    gear.onclick = (e) => openToggleGear(node, e);
    meta.append(panelToggle, linkInfo, gear);
    root.appendChild(meta);

    /* panel */
    const panel = document.createElement("div");
    panel.className = "afs-panel";
    const bar = document.createElement("div");
    bar.className = "afs-panel-bar";
    const filter = document.createElement("input");
    filter.className = "asw-input";
    filter.placeholder = "filter groups…";
    filter.addEventListener("input", () => node.afsRender());
    const btnCap = document.createElement("button");
    btnCap.className = "asw-btn";
    btnCap.textContent = "📸";
    btnCap.title = "Assign every group that is on right now to this side, and the rest to the other";
    btnCap.onclick = () => captureToggle(node);
    bar.append(filter, btnCap);
    const list = document.createElement("div");
    list.className = "afs-list";
    panel.append(bar, list);
    root.appendChild(panel);

    for (const ev of ["mousedown", "pointerdown", "wheel", "contextmenu"]) {
        root.addEventListener(ev, (e) => e.stopPropagation());
    }

    node.afsEls = { root, labA, labB, track, panelToggle, linkInfo, panel, list, filter };
    return root;
}

function openToggleGear(node, e) {
    const st = node.afsState;
    const models = modelsNodes(node);
    const tick = (v) => (v ? "☑ " : "☐ ");
    popupMenu(e.clientX, e.clientY, [
        { head: "Off side" },
        { content: (st.opts.off !== "mute" ? "● " : "○ ") + "Bypass", callback: () => { st.opts.off = "bypass"; node.afsSync(); applyGroups(node); } },
        { content: (st.opts.off === "mute" ? "● " : "○ ") + "Mute", callback: () => { st.opts.off = "mute"; node.afsSync(); applyGroups(node); } },
        "-",
        { content: tick(st.opts.applyOnLoad) + "Apply on workflow load", callback: () => { st.opts.applyOnLoad = !st.opts.applyOnLoad; node.afsSync(); } },
        { content: tick(st.opts.shareLabels) + "Push labels to my Models nodes", callback: () => { st.opts.shareLabels = !st.opts.shareLabels; node.afsSync(); pushLabels(node); } },
        "-",
        { content: "✎ Rename " + labelOf(st, "a") + " (left)", callback: () => {
            const v = askText("Left label:", labelOf(st, "a"));
            if (v) { st.labels.a = v; node.afsSync(); pushLabels(node); node.afsRender(); }
        } },
        { content: "✎ Rename " + labelOf(st, "b") + " (right)", callback: () => {
            const v = askText("Right label:", labelOf(st, "b"));
            if (v) { st.labels.b = v; node.afsSync(); pushLabels(node); node.afsRender(); }
        } },
        "-",
        // Si pones el interruptor despues de los selectores, se reclaman desde
        // aqui en vez de ir nodo por nodo.
        ...(models.length ? [{ head: "Models nodes on this switch" }] : []),
        ...models.map((m) => {
            const mine = m.afsState?.link === channelOf(node);
            return {
                content: (mine ? "● " : "○ ") + `#${m.id} ${m.title || "Fast Switch Models"}`,
                callback: () => linkModelsTo(m, mine ? null : node),
            };
        }),
        ...(models.length ? ["-"] : []),
        { content: "▶ Re-apply now", callback: () => applyGroups(node) },
        { content: "🧹 Unassign every group", callback: () => { st.groups = {}; node.afsSync(); node.afsRender(); } },
    ]);
}

function renderToggle(node) {
    const st = node.afsState;
    const { labA, labB, track, panelToggle, linkInfo, panel, list, filter } = node.afsEls;

    labA.textContent = labelOf(st, "a");
    labB.textContent = labelOf(st, "b");
    labA.className = "afs-lab afs-lab-a " + (st.side === "a" ? "on" : "off");
    labB.className = "afs-lab afs-lab-b " + (st.side === "b" ? "on" : "off");
    track.className = "afs-track side-" + st.side;

    const groups = listGroups(node);
    let nA = 0, nB = 0;
    for (const g of groups) {
        const m = st.groups[groupKey(g)];
        if (m === "a") nA += 1; else if (m === "b") nB += 1;
    }
    panelToggle.textContent = `${st.collapsed ? "▸" : "▾"} groups · ${nA} ${labelOf(st, "a")} / ${nB} ${labelOf(st, "b")}`;

    // Cuantos nodos Models siguen a ESTE interruptor. Verlo evita justo la
    // confusion de creer que un switch manda sobre todo el grafo.
    const followers = followerCount(node);
    linkInfo.textContent = `🔗 ${followers}`;
    linkInfo.title = followers
        ? `${followers} Models node(s) follow this switch`
        : "No Models node follows this switch yet";
    linkInfo.style.opacity = followers ? "1" : ".45";
    panel.style.display = st.collapsed ? "none" : "flex";

    if (!st.collapsed) {
        const q = (filter.value || "").trim().toLowerCase();
        list.textContent = "";
        let shown = 0;
        for (const g of groups) {
            const key = groupKey(g);
            if (q && !key.toLowerCase().includes(q)) continue;
            const mark = st.groups[key];

            const row = document.createElement("div");
            row.className = "afs-grow";

            const dot = document.createElement("span");
            const live = liveGroupState(g);
            dot.className = "afs-live" + (live ? ` l-${live}` : "");

            const name = document.createElement("span");
            name.className = "afs-gname";
            name.textContent = key;
            name.title = key;

            const seg = document.createElement("div");
            seg.className = "afs-seg";
            for (const [val, txt, title] of [
                ["a", "A", `On when the switch is on ${labelOf(st, "a")}`],
                ["b", "B", `On when the switch is on ${labelOf(st, "b")}`],
                ["", "–", "Never touched by this switch"],
            ]) {
                const b = document.createElement("button");
                b.textContent = txt;
                b.title = title;
                if ((mark || "") === val) b.className = val ? `sel-${val}` : "sel-off";
                b.onclick = () => {
                    if (val) st.groups[key] = val; else delete st.groups[key];
                    node.afsSync();
                    applyGroups(node);
                    node.afsRender();
                };
                seg.appendChild(b);
            }

            row.append(dot, name, seg);
            list.appendChild(row);
            shown += 1;
        }
        if (!shown) {
            const hint = document.createElement("div");
            hint.className = "afs-hint";
            hint.innerHTML = groups.length
                ? "No group matches the filter."
                : "No groups in this graph yet.<br>Right-click the canvas → Add Group.";
            list.appendChild(hint);
        }
        node.afsRows = Math.max(shown, 1);
    }
    fitToggle(node);
}

function fitToggle(node) {
    const st = node.afsState;
    const rows = st.collapsed ? 0 : node.afsRows;
    if (!st.collapsed) {
        node.afsEls.list.style.maxHeight = Math.min(240, rows * 22 + 8) + "px";
    }
    // Estimacion de reserva por si aun no hay nada montado en el DOM.
    const fallback = st.collapsed ? 60 : 60 + Math.min(240, rows * 22 + 8) + 30;
    fitToContent(node, 300, fallback, `${st.collapsed ? "c" : "o"}:${rows}`, false);
}

/* ================================================================== MODELS */

let FOLDERS_CACHE = null;

async function fetchFolders() {
    if (FOLDERS_CACHE) return FOLDERS_CACHE;
    try {
        const r = await fetch("/academia/fastswitch/folders");
        FOLDERS_CACHE = (await r.json()).folders || [];
    } catch (e) {
        FOLDERS_CACHE = [];
    }
    return FOLDERS_CACHE;
}

async function fetchFiles(node) {
    const folder = node.afsState.folder || DEFAULT_FOLDER;
    try {
        const r = await fetch("/academia/fastswitch/files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder }),
        });
        const j = await r.json();
        node.afsFiles = j.files || [];
        node.afsError = j.error || null;
    } catch (e) {
        node.afsFiles = [];
        node.afsError = String(e);
    }
    node.afsRender();
}

function modelsDefaults() {
    return {
        side: "a",
        labels: { a: "A", b: "B" },
        folder: DEFAULT_FOLDER,
        a: "",
        b: "",
        link: "",                  // id del Toggle que manda; "" = independiente
        opts: { shareLabels: true },
    };
}

function normalizeModels(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const d = modelsDefaults();
    s.side = s.side === "b" ? "b" : "a";
    s.labels = { a: s.labels?.a || d.labels.a, b: s.labels?.b || d.labels.b };
    s.folder = s.folder || d.folder;
    s.a = typeof s.a === "string" ? s.a : "";
    s.b = typeof s.b === "string" ? s.b : "";
    s.link = typeof s.link === "string" ? s.link : "";
    s.opts = Object.assign({}, d.opts, s.opts || {});
    return s;
}

function setModelsSide(node, side, { relay = true } = {}) {
    const t = relay ? linkedToggle(node) : null;
    if (t) {
        // Enlazado: no decide por su cuenta. Le pide el cambio a su Toggle, que
        // aplicara sus grupos y respondera a todos sus seguidores a la vez.
        emit(node, { kind: "flip", to: channelOf(t), side });
        return;
    }
    node.afsState.side = side === "b" ? "b" : "a";
    node.afsSync();
    node.afsRender();
}

function buildModelsUI(node) {
    injectStyle();
    const root = document.createElement("div");
    root.className = "afs-root";

    const folderBar = document.createElement("div");
    folderBar.className = "afs-folder";
    const pathEl = document.createElement("div");
    pathEl.className = "afs-path";
    pathEl.onclick = (e) => openModelsGear(node, e);
    const linkChip = document.createElement("span");
    linkChip.className = "afs-linkchip";
    linkChip.onclick = (e) => openLinkMenu(node, e);
    const gear = document.createElement("div");
    gear.className = "afs-gear";
    gear.textContent = "⚙";
    gear.onclick = (e) => openModelsGear(node, e);
    folderBar.append(pathEl, linkChip, gear);
    root.appendChild(folderBar);

    const err = document.createElement("div");
    err.className = "afs-err";
    err.style.display = "none";
    root.appendChild(err);

    const slots = {};
    for (const side of ["a", "b"]) {
        const slot = document.createElement("div");
        slot.className = "afs-slot";

        const dot = document.createElement("button");
        dot.className = "afs-dot";
        dot.onclick = () => setModelsSide(node, side);

        const name = document.createElement("div");
        name.className = "afs-name";
        clickOrDouble(name,
            () => setModelsSide(node, side),
            () => editInline(name, labelOf(node.afsState, side),
                             (v) => renameModelsLabel(node, side, v)));
        name.title = "Click: make this the active slot · double click: rename";

        const file = document.createElement("select");
        file.className = "afs-file";
        file.onchange = () => {
            node.afsState[side] = file.value;
            node.afsSync();
            node.afsRender();
        };

        slot.append(dot, name, file);
        root.appendChild(slot);
        slots[side] = { slot, dot, name, file };
    }

    for (const ev of ["mousedown", "pointerdown", "wheel", "contextmenu"]) {
        root.addEventListener(ev, (e) => e.stopPropagation());
    }

    node.afsEls = { root, pathEl, linkChip, err, slots };
    return root;
}

// Elegir a que interruptor obedece este nodo. Se saca a su propio menu porque
// es la pregunta que mas se hace en cuanto hay mas de un Fast Switch.
function openLinkMenu(node, e) {
    const st = node.afsState;
    const toggles = toggleNodes(node);
    const current = linkedToggle(node);
    const items = [{ head: "Which switch commands this node" }];

    if (!toggles.length) {
        items.push({ content: "No Fast Switch Toggle in this graph", callback: () => {} });
    }
    for (const t of toggles) {
        items.push({
            content: (st.link === channelOf(t) ? "● " : "○ ") + toggleTitle(t),
            callback: () => linkModelsTo(node, t),
        });
    }
    items.push({
        content: (!st.link ? "● " : "○ ") + "Standalone (independent A/B)",
        callback: () => linkModelsTo(node, null),
    });
    if (current) {
        items.push("-", { content: "↳ Go to that switch", callback: () => goToNode(current) });
    }
    popupMenu(e.clientX, e.clientY, items);
}

async function openModelsGear(node, e) {
    const st = node.afsState;
    const folders = await fetchFolders();
    const tick = (v) => (v ? "☑ " : "☐ ");
    const items = [
        { head: "Folder" },
        ...folders.slice(0, 24).map((f) => ({
            content: (f === st.folder ? "● " : "○ ") + f,
            callback: () => { st.folder = f; node.afsSync(); fetchFiles(node); },
        })),
        { content: "✎ Type a path…", callback: () => {
            const v = askText("Models folder (e.g. models/loras, or any path):", st.folder);
            if (v) { st.folder = v; node.afsSync(); fetchFiles(node); }
        } },
        "-",
        { content: "🔄 Refresh file list", callback: () => fetchFiles(node) },
        "-",
        { content: "✎ Rename " + labelOf(st, "a"), callback: () => {
            const v = askText("Label A:", labelOf(st, "a"));
            if (v) renameModelsLabel(node, "a", v);
        } },
        { content: "✎ Rename " + labelOf(st, "b"), callback: () => {
            const v = askText("Label B:", labelOf(st, "b"));
            if (v) renameModelsLabel(node, "b", v);
        } },
        "-",
        { head: "Follow which switch" },
        { content: (!st.link ? "● " : "○ ") + "Standalone (independent A/B)",
          callback: () => { st.link = ""; node.afsSync(); node.afsRender(); } },
        ...toggleNodes(node).map((t) => ({
            content: (st.link === channelOf(t) ? "● " : "○ ") + toggleTitle(t),
            callback: () => linkModelsTo(node, t),
        })),
        { content: tick(st.opts.shareLabels) + "Adopt labels from that switch",
          callback: () => {
              st.opts.shareLabels = !st.opts.shareLabels;
              node.afsSync();
              const t = linkedToggle(node);
              if (st.opts.shareLabels && t?.afsState?.labels) adoptLabels(node, t.afsState.labels);
              node.afsRender();
          } },
    ];
    popupMenu(e.clientX, e.clientY, items);
}

function renderModels(node) {
    const st = node.afsState;
    const { pathEl, linkChip, err, slots } = node.afsEls;
    const files = node.afsFiles || [];

    pathEl.textContent = "📁 " + st.folder;
    pathEl.title = "Folder for both slots — click to change";

    // Que interruptor manda sobre este nodo, a la vista y no escondido en un menu.
    const t = linkedToggle(node);
    if (t) {
        linkChip.textContent = `🔗 #${t.id}`;
        linkChip.title = `Follows "${t.title || "Fast Switch Toggle"}" (node #${t.id})`;
        linkChip.className = "afs-linkchip";
    } else if (st.link) {
        linkChip.textContent = "🔗 ⚠";
        linkChip.title = `The switch it followed (#${st.link}) is gone — pick another one in ⚙`;
        linkChip.className = "afs-linkchip broken";
    } else {
        linkChip.textContent = "🔗 —";
        linkChip.title = "Standalone: this node obeys nobody. Pick a switch in ⚙";
        linkChip.className = "afs-linkchip none";
    }

    if (node.afsError) {
        err.style.display = "";
        err.textContent = "⚠ " + node.afsError;
    } else {
        err.style.display = "none";
    }

    for (const side of ["a", "b"]) {
        const { slot, name, file } = slots[side];
        const active = st.side === side;
        slot.className = "afs-slot " + (active ? "on" : "off");
        name.textContent = labelOf(st, side);
        name.title = `${labelOf(st, side)} — click to activate, double click to rename`;

        const current = st[side] || "";
        const values = files.slice();
        const missing = current && !values.includes(current);
        if (missing) values.unshift(current);

        file.textContent = "";
        if (!current) {
            const o = document.createElement("option");
            o.value = "";
            o.textContent = files.length ? "— pick a model —" : "— no files —";
            file.appendChild(o);
        }
        for (const v of values) {
            const o = document.createElement("option");
            o.value = v;
            o.textContent = (missing && v === current) ? v + "  (missing)" : v;
            file.appendChild(o);
        }
        file.value = current;
        file.classList.toggle("missing", !!missing);
        file.title = current || "No model selected";
    }
    fitModels(node);
}

function fitModels(node) {
    // El contenido es fijo (dos ranuras), asi que el alto queda clavado: se
    // bloquea tambien el maximo para que el widget no se estire si alguien
    // agranda el nodo.
    const err = node.afsError ? 1 : 0;
    fitToContent(node, 380, 96 + err * 19, `slots:${err}`, true);
}

/* =============================================================== registro */

function commonSetup(node, { normalize, build, render, onBus, onLoad }) {
    node.afsUid = uid("n");

    const dataWidget = node.widgets?.find((w) => w.name === "switch_data");
    if (dataWidget) {
        dataWidget.type = "hidden";
        dataWidget.computeSize = () => [0, -4];
        dataWidget.draw = () => {};
    }
    node.afsData = dataWidget;
    node.afsState = normalize(null);
    node.afsRows = 1;

    node.afsSync = function () {
        if (node.afsData) node.afsData.value = JSON.stringify(node.afsState);
        redraw();
    };
    node.afsRender = function () {
        try { render(node); } catch (e) { console.error("[Fast Switch] render", e); }
    };

    node.afsWidget = addFittedDOMWidget(node, "AFS", build(node));

    node.onResize = function (size) {
        clampToMin(node, size);
    };

    node.afsUnsub = listenBus(node, (evt) => onBus(node, evt));

    node.afsSync();
    setTimeout(() => { node.afsRender(); onLoad?.(node); }, 60);
}

function installLifecycle(nodeType, { restore }) {
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
        try { this.afsUnsub?.(); } catch (e) {}
        if (this.afsTimer) clearInterval(this.afsTimer);
        onRemoved?.apply(this, arguments);
    };

    const onSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function () {
        if (this.afsData && this.afsState) this.afsData.value = JSON.stringify(this.afsState);
        onSerialize?.apply(this, arguments);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
        onConfigure?.apply(this, arguments);
        const self = this;
        // Viene de un workflow guardado: su enlace ya esta decidido, no se
        // reinventa por debajo.
        this.afsConfigured = true;
        const w = this.widgets?.find((x) => x.name === "switch_data");
        if (w?.value) {
            try { restore(self, JSON.parse(w.value)); }
            catch (e) { console.error("[Fast Switch] bad saved state", e); }
        }
        setTimeout(() => self.afsOnLoad?.(), 240);
    };
}

app.registerExtension({
    name: "AcademiaSD.FastSwitch",

    setup() {
        // Al refrescar la lista de modelos de ComfyUI, refrescamos la nuestra.
        const original = app.refreshComboInNodes;
        app.refreshComboInNodes = function () {
            const res = original?.apply(this, arguments);
            FOLDERS_CACHE = null;
            for (const n of app.graph?._nodes || []) {
                if (n.type === T_MODELS) fetchFiles(n);
            }
            return res;
        };
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {

        /* ---------------------------------------------------------- TOGGLE */
        if (nodeData.name === T_TOGGLE) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                onNodeCreated?.apply(this, arguments);
                const self = this;
                commonSetup(this, {
                    normalize: normalizeToggle,
                    build: buildToggleUI,
                    render: renderToggle,
                    // Un Toggle jamas obedece a otro Toggle. Lo unico que
                    // atiende es la peticion de cambio de un Models suyo.
                    onBus: (n, evt) => {
                        if (evt.kind === "flip" && evt.to === channelOf(n)) {
                            setToggleSide(n, evt.side);
                        }
                    },
                });
                this.afsOnLoad = () => {
                    self.afsRender();
                    if (self.afsState?.opts?.applyOnLoad) applyGroups(self);
                };

                // Los grupos se crean y se renombran fuera de aqui.
                let sig = "";
                this.afsTimer = setInterval(() => {
                    if (!self.graph || self.flags?.collapsed) return;
                    if (app.canvas?.graph && app.canvas.graph !== self.graph) return;
                    let s = "";
                    for (const g of listGroups(self)) s += groupKey(g) + ":" + (liveGroupState(g) || "-") + "|";
                    if (s !== sig) { sig = s; self.afsRender(); }
                }, 900);
            };

            installLifecycle(nodeType, {
                restore: (node, parsed) => { node.afsState = normalizeToggle(parsed); },
            });

            const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (_, options) {
                getExtraMenuOptions?.apply(this, arguments);
                const self = this;
                options.push(null,
                    { content: "Fast Switch: re-apply", callback: () => applyGroups(self) },
                    { content: "Fast Switch: capture groups into this side", callback: () => captureToggle(self) });
            };
        }

        /* ---------------------------------------------------------- MODELS */
        if (nodeData.name === T_MODELS) {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                onNodeCreated?.apply(this, arguments);
                const self = this;
                commonSetup(this, {
                    normalize: normalizeModels,
                    build: buildModelsUI,
                    render: renderModels,
                    onBus: (n, evt) => {
                        if (!evt.from || evt.from !== n.afsState.link) return;
                        if (evt.kind === "side") setModelsSide(n, evt.side, { relay: false });
                        else if (evt.kind === "labels") adoptLabels(n, evt.labels);
                    },
                    onLoad: (n) => fetchFiles(n),
                });
                this.afsOnLoad = () => fetchFiles(self);

                // Nodo recien puesto a mano: si en el grafo hay exactamente un
                // interruptor, se engancha solo. Con varios se queda
                // independiente a proposito, porque adivinar cual seria
                // precisamente el comportamiento global que hay que evitar.
                setTimeout(() => {
                    if (self.afsConfigured || self.afsState.link) return;
                    const ts = toggleNodes(self);
                    if (ts.length === 1) {
                        linkModelsTo(self, ts[0]);
                        console.log(`[Fast Switch] #${self.id} linked to switch #${ts[0].id}`);
                    } else {
                        self.afsRender();
                    }
                }, 320);
            };

            installLifecycle(nodeType, {
                restore: (node, parsed) => { node.afsState = normalizeModels(parsed); },
            });

            const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
            nodeType.prototype.getExtraMenuOptions = function (_, options) {
                getExtraMenuOptions?.apply(this, arguments);
                const self = this;
                options.push(null,
                    { content: "Fast Switch: refresh file list", callback: () => fetchFiles(self) });
            };
        }
    },
});
