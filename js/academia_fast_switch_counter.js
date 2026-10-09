// academia_fast_switch_counter.js
// Academia SD Fast Switch · Counter: un deslizador por pasos OFF, 1, 2, 3...
//
// Es el hermano del Toggle, con la misma filosofia: manda sobre SUS grupos,
// identificados por titulo, y nunca sobre los de otro interruptor. Cada grupo
// recibe un nivel (1, 2, 3...) o "–" (no se toca). Con el valor N:
//
//   acumulativo (por defecto)  se encienden los niveles 1..N, el resto bypass.
//                              "Cuantas referencias activas": 0 = ninguna.
//   exacto                     solo se enciende el nivel N. Elegir una opcion
//                              entre varias.
//
// A stepped slider. Each group gets a level or "–" (untouched). Value N turns
// on levels 1..N (cumulative) or only level N (exact); the rest is bypassed.

import { app } from "../../scripts/app.js";
import {
    uid, redraw, listGroups, groupKey, liveGroupState, setGroupState,
    popupMenu, askText, injectStyle as injectCoreStyle,
    addFittedDOMWidget, fitToContent, clampToMin,
} from "./academia_switch_core.js";

const T_COUNTER = "Academia_Fast_Switch_Counter";
const MAX_LIMIT = 32;

/* ------------------------------------------------------------------ estilo */

const STYLE_ID = "academia-fast-switch-counter-style";

function injectStyle() {
    injectCoreStyle();                     // menus y campos compartidos
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
.afc-root { width:100%; box-sizing:border-box; display:flex; flex-direction:column;
    gap:5px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size:11px; color:#c9d1d9; padding:2px 0; }
.afc-root * { box-sizing:border-box; }

.afc-switch { display:flex; align-items:center; justify-content:center; gap:10px;
    padding:2px 4px; }
.afc-lab { font-weight:700; font-size:12px; letter-spacing:.2px; cursor:pointer;
    user-select:none; padding:2px 5px; border-radius:4px; min-width:38px;
    text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    transition:color .16s, text-shadow .16s; }
.afc-lab.on  { color:#3fb950; text-shadow:0 0 10px rgba(63,185,80,.45); }
.afc-lab.off { color:#f85149; text-shadow:0 0 10px rgba(248,81,73,.35); }
.afc-lab:hover { background:rgba(255,255,255,0.06); }
.afc-lab input { width:70px; background:#0d1117; border:1px solid #4a6ee0; color:#e6edf3;
    font:inherit; font-weight:700; border-radius:4px; padding:1px 4px; outline:none; }

.afc-num { font-weight:800; font-size:15px; min-width:28px; text-align:left;
    cursor:pointer; user-select:none; padding:0 4px; border-radius:4px;
    font-variant-numeric: tabular-nums; transition:color .16s; }
.afc-num.on  { color:#3fb950; text-shadow:0 0 10px rgba(63,185,80,.45); }
.afc-num.off { color:#6e7681; }
.afc-num:hover { background:rgba(255,255,255,0.06); }
.afc-num small { font-size:10px; font-weight:600; color:#6e7681; margin-left:1px; }

.afc-track { position:relative; height:28px; flex:none; border-radius:15px;
    background:#080b0f; border:1px solid #30363d; cursor:pointer;
    box-shadow: inset 0 2px 6px rgba(0,0,0,.9); touch-action:none; overflow:hidden; }
.afc-track.on  { border-color:#3fb95055; }
.afc-track.off { border-color:#f8514944; }
.afc-fill { position:absolute; left:0; top:0; bottom:0; border-radius:15px;
    background:linear-gradient(90deg, rgba(63,185,80,.05), rgba(63,185,80,.32));
    transition:width .17s cubic-bezier(.34,1.5,.5,1); pointer-events:none; }
.afc-tick { position:absolute; top:12px; width:4px; height:4px; margin-left:-2px;
    border-radius:50%; background:#30363d; pointer-events:none; }
.afc-tick.lit { background:#3fb95099; }
.afc-knob { position:absolute; top:3px; left:3px; width:20px; height:20px;
    border-radius:50%; background:linear-gradient(#f0f6fc,#8b949e);
    box-shadow:0 2px 4px rgba(0,0,0,.75), inset 0 -2px 3px rgba(0,0,0,.25);
    transition:left .17s cubic-bezier(.34,1.5,.5,1); pointer-events:none; }
.afc-track.dragging .afc-knob, .afc-track.dragging .afc-fill { transition:none; }

.afc-meta { display:flex; align-items:center; gap:6px; color:#8b949e; font-size:10px; }
.afc-meta .afc-toggle-panel { cursor:pointer; user-select:none; flex:1; min-width:0;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:2px 4px;
    border-radius:4px; }
.afc-meta .afc-toggle-panel:hover { background:rgba(255,255,255,0.06); color:#c9d1d9; }
.afc-gear { cursor:pointer; padding:1px 5px; border-radius:4px; color:#8b949e; }
.afc-gear:hover { background:rgba(255,255,255,0.08); color:#e6edf3; }

.afc-panel { display:flex; flex-direction:column; gap:4px; }
.afc-panel-bar { display:flex; gap:5px; align-items:center; }
.afc-list { border:1px solid #30363d; border-radius:6px; background:rgba(0,0,0,.25);
    overflow-y:auto; }
.afc-list::-webkit-scrollbar { width:8px; }
.afc-list::-webkit-scrollbar-thumb { background:#484f58; border-radius:4px; }
.afc-grow { display:flex; align-items:center; gap:6px; padding:2px 6px;
    border-bottom:1px solid #21262d; }
.afc-grow:last-child { border-bottom:none; }
.afc-grow:hover { background:rgba(255,255,255,0.03); }
.afc-gname { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.afc-live { display:inline-block; width:6px; height:6px; border-radius:50%;
    margin-right:5px; vertical-align:middle; background:#484f58; flex:none; }
.afc-live.l-on { background:#3fb950; }
.afc-live.l-bypass { background:#a371f7; }
.afc-live.l-mute { background:#f85149; }
.afc-live.l-mixed { background:#d29922; }
.afc-level { flex:none; width:52px; padding:1px 3px; background:#0d1117; color:#8b949e;
    border:1px solid #30363d; border-radius:4px; font:inherit; font-weight:700; outline:none; }
.afc-level.set { color:#c9d1d9; }
.afc-level.lit { border-color:#3fb950; color:#3fb950; }
.afc-hint { color:#6e7681; font-size:10px; text-align:center; padding:8px 4px; line-height:1.5; }
`;
    document.head.appendChild(s);
}

/* ------------------------------------------------------------------ estado */

function defaults() {
    return {
        value: 0,
        last: 1,                          // a donde vuelve al pulsar OFF -> ON
        max: 4,
        mode: "cumulative",               // "cumulative" | "exact"
        labels: { off: "OFF", on: "ON" },
        groups: {},                       // { titulo: nivel (1..max) }  ausente = no se toca
        collapsed: true,
        opts: { off: "bypass", applyOnLoad: false },
    };
}

function normalize(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const d = defaults();
    const int = (v, lo, hi, fb) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb;
    };
    s.groups = s.groups && typeof s.groups === "object" ? s.groups : {};
    for (const k of Object.keys(s.groups)) {
        const lv = int(s.groups[k], 1, MAX_LIMIT, 0);
        if (lv) s.groups[k] = lv; else delete s.groups[k];
    }
    const highest = Math.max(0, ...Object.values(s.groups));
    s.max = int(s.max, 1, MAX_LIMIT, Math.max(d.max, highest));
    s.value = int(s.value, 0, s.max, 0);
    s.last = int(s.last, 1, s.max, 1);
    s.mode = s.mode === "exact" ? "exact" : "cumulative";
    s.labels = { off: s.labels?.off || d.labels.off, on: s.labels?.on || d.labels.on };
    s.collapsed = s.collapsed !== false;
    s.opts = Object.assign({}, d.opts, s.opts || {});
    return s;
}

// Un nivel queda encendido con el valor actual? / Is this level on right now?
function levelOn(st, level) {
    if (!level || st.value <= 0) return false;
    return st.mode === "exact" ? level === st.value : level <= st.value;
}

function applyGroups(node) {
    const st = node.afcState;
    const off = st.opts.off === "mute" ? "mute" : "bypass";
    let touched = 0, on = 0, offCount = 0;
    for (const g of listGroups(node)) {
        const level = st.groups[groupKey(g)];
        if (!level) continue;
        const wanted = levelOn(st, level) ? "on" : off;
        if (wanted === "on") on += 1; else offCount += 1;
        touched += setGroupState(g, wanted);
    }
    redraw();
    console.log(`[Fast Switch Counter] ${st.value}: ${on} group(s) on, ` +
                `${offCount} ${off}, ${touched} node(s) changed`);
}

function setValue(node, value) {
    const st = node.afcState;
    const v = Math.max(0, Math.min(st.max, Math.round(value)));
    if (v > 0) st.last = v;
    if (v === st.value) { node.afcRender(); return; }
    st.value = v;
    applyGroups(node);
    node.afcSync();
    node.afcRender();
}

// Numera los grupos visibles (con el filtro) en el orden en que aparecen: lo
// normal es tener "Ref 1", "Ref 2"... y no querer asignarlos uno a uno.
// Numbers the visible groups in order.
function autoNumber(node) {
    const st = node.afcState;
    const q = (node.afcEls.filter.value || "").trim().toLowerCase();
    let n = 0;
    for (const g of listGroups(node)) {
        const key = groupKey(g);
        if (q && !key.toLowerCase().includes(q)) continue;
        n += 1;
        if (n > MAX_LIMIT) break;
        st.groups[key] = n;
    }
    if (n > st.max) st.max = Math.min(MAX_LIMIT, n);
    node.afcSync();
    applyGroups(node);
    node.afcRender();
}

/* ---------------------------------------------------------- inline rename */

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

/* ------------------------------------------------------------------ pista */

const KNOB = 20, PAD = 3;

function trackWidth(max) {
    return Math.max(90, Math.min(230, 40 + max * 22));
}

function knobLeft(st, value, width) {
    const travel = width - 2 - PAD * 2 - KNOB;
    return PAD + (st.max ? (value / st.max) * travel : 0);
}

function valueAt(st, clientX, rect) {
    const travel = rect.width - 2 - PAD * 2 - KNOB;
    const x = clientX - rect.left - 1 - PAD - KNOB / 2;
    return Math.max(0, Math.min(st.max, Math.round((x / travel) * st.max)));
}

function buildTrack(node) {
    const track = document.createElement("div");
    track.className = "afc-track";
    const fill = document.createElement("div");
    fill.className = "afc-fill";
    const ticks = document.createElement("div");
    const knob = document.createElement("div");
    knob.className = "afc-knob";
    track.append(fill, ticks, knob);

    // Se arrastra con el iman de cada paso, y un clic va directo a ese paso.
    // Drag snaps to steps; a click jumps straight to that step.
    let dragging = false;
    track.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        dragging = true;
        track.classList.add("dragging");
        try { track.setPointerCapture(e.pointerId); } catch (err) {}
        preview(e);
    });
    const preview = (e) => {
        const st = node.afcState;
        const rect = track.getBoundingClientRect();
        const v = valueAt(st, e.clientX, rect);
        const left = knobLeft(st, v, rect.width);
        knob.style.left = left + "px";
        fill.style.width = (v > 0 ? left + KNOB + PAD : 0) + "px";
    };
    track.addEventListener("pointermove", (e) => { if (dragging) preview(e); });
    track.addEventListener("pointerup", (e) => {
        if (!dragging) return;
        dragging = false;
        track.classList.remove("dragging");
        knob.style.left = fill.style.width = "";
        setValue(node, valueAt(node.afcState, e.clientX, track.getBoundingClientRect()));
    });
    track.addEventListener("pointercancel", () => {
        dragging = false;
        track.classList.remove("dragging");
        knob.style.left = fill.style.width = "";
        node.afcRender();
    });
    track.addEventListener("wheel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setValue(node, node.afcState.value + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });

    return { track, fill, ticks, knob };
}

/* --------------------------------------------------------------------- UI */

function buildUI(node) {
    injectStyle();
    const root = document.createElement("div");
    root.className = "afc-root";

    const sw = document.createElement("div");
    sw.className = "afc-switch";
    const lab = document.createElement("div");
    lab.className = "afc-lab";
    const { track, fill, ticks, knob } = buildTrack(node);
    const num = document.createElement("div");
    num.className = "afc-num";

    // Clic en la etiqueta: OFF <-> ultimo valor. Doble clic: renombrar la que
    // se ve. / Click the label: OFF <-> last value; double click: rename it.
    clickOrDouble(lab,
        () => {
            const st = node.afcState;
            setValue(node, st.value > 0 ? 0 : (st.last || 1));
        },
        () => {
            const st = node.afcState;
            const which = st.value > 0 ? "on" : "off";
            editInline(lab, st.labels[which], (v) => {
                st.labels[which] = v;
                node.afcSync();
                node.afcRender();
            });
        });
    lab.title = "Click: OFF / back on · double click: rename";
    // El numero sube de uno en uno y vuelve a 0 al pasar del maximo.
    num.onclick = () => {
        const st = node.afcState;
        setValue(node, st.value >= st.max ? 0 : st.value + 1);
    };
    num.title = "Click: +1 (wraps to 0) · wheel over the slider: ±1";

    sw.append(lab, track, num);
    root.appendChild(sw);

    const meta = document.createElement("div");
    meta.className = "afc-meta";
    const panelToggle = document.createElement("div");
    panelToggle.className = "afc-toggle-panel";
    panelToggle.onclick = () => {
        node.afcState.collapsed = !node.afcState.collapsed;
        node.afcSync();
        node.afcRender();
    };
    const gear = document.createElement("div");
    gear.className = "afc-gear";
    gear.textContent = "⚙";
    gear.onclick = (e) => openGear(node, e);
    meta.append(panelToggle, gear);
    root.appendChild(meta);

    const panel = document.createElement("div");
    panel.className = "afc-panel";
    const bar = document.createElement("div");
    bar.className = "afc-panel-bar";
    const filter = document.createElement("input");
    filter.className = "asw-input";
    filter.placeholder = "filter groups…";
    filter.addEventListener("input", () => node.afcRender());
    filter.addEventListener("keydown", (e) => e.stopPropagation());
    const btnAuto = document.createElement("button");
    btnAuto.className = "asw-btn";
    btnAuto.textContent = "🔢";
    btnAuto.title = "Number the visible groups 1, 2, 3… in order (use the filter, e.g. 'Ref')";
    btnAuto.onclick = () => autoNumber(node);
    bar.append(filter, btnAuto);
    const list = document.createElement("div");
    list.className = "afc-list";
    panel.append(bar, list);
    root.appendChild(panel);

    for (const ev of ["mousedown", "pointerdown", "wheel", "contextmenu"]) {
        root.addEventListener(ev, (e) => e.stopPropagation());
    }

    node.afcEls = { root, lab, track, fill, ticks, knob, num, panelToggle, panel, list, filter };
    return root;
}

function openGear(node, e) {
    const st = node.afcState;
    const tick = (v) => (v ? "☑ " : "☐ ");
    popupMenu(e.clientX, e.clientY, [
        { head: "Mode" },
        { content: (st.mode === "cumulative" ? "● " : "○ ") + "Cumulative — value N turns on levels 1…N",
          callback: () => { st.mode = "cumulative"; node.afcSync(); applyGroups(node); node.afcRender(); } },
        { content: (st.mode === "exact" ? "● " : "○ ") + "Exact — value N turns on only level N",
          callback: () => { st.mode = "exact"; node.afcSync(); applyGroups(node); node.afcRender(); } },
        "-",
        { content: `✎ Steps (max value): ${st.max}`, callback: () => {
            const v = parseInt(askText(`Number of steps (1–${MAX_LIMIT}):`, String(st.max)), 10);
            if (Number.isFinite(v)) {
                st.max = Math.max(1, Math.min(MAX_LIMIT, v));
                if (st.value > st.max) { st.value = st.max; applyGroups(node); }
                if (st.last > st.max) st.last = st.max;
                node.afcSync();
                node.afcRender();
            }
        } },
        { head: "Off groups" },
        { content: (st.opts.off !== "mute" ? "● " : "○ ") + "Bypass", callback: () => { st.opts.off = "bypass"; node.afcSync(); applyGroups(node); } },
        { content: (st.opts.off === "mute" ? "● " : "○ ") + "Mute", callback: () => { st.opts.off = "mute"; node.afcSync(); applyGroups(node); } },
        "-",
        { content: tick(st.opts.applyOnLoad) + "Apply on workflow load", callback: () => { st.opts.applyOnLoad = !st.opts.applyOnLoad; node.afcSync(); } },
        { content: `✎ Rename "${st.labels.off}"`, callback: () => {
            const v = askText("Label when the value is 0:", st.labels.off);
            if (v) { st.labels.off = v; node.afcSync(); node.afcRender(); }
        } },
        { content: `✎ Rename "${st.labels.on}"`, callback: () => {
            const v = askText("Label when the value is 1 or more:", st.labels.on);
            if (v) { st.labels.on = v; node.afcSync(); node.afcRender(); }
        } },
        "-",
        { content: "🔢 Number visible groups 1, 2, 3…", callback: () => autoNumber(node) },
        { content: "▶ Re-apply now", callback: () => applyGroups(node) },
        { content: "🧹 Unassign every group", callback: () => { st.groups = {}; node.afcSync(); node.afcRender(); } },
    ]);
}

function render(node) {
    const st = node.afcState;
    const { lab, track, fill, ticks, knob, num, panelToggle, panel, list, filter } = node.afcEls;
    const on = st.value > 0;

    lab.textContent = on ? st.labels.on : st.labels.off;
    lab.className = "afc-lab " + (on ? "on" : "off");
    num.className = "afc-num " + (on ? "on" : "off");
    num.innerHTML = "";
    num.append(String(st.value));
    const small = document.createElement("small");
    small.textContent = "/" + st.max;
    num.appendChild(small);

    const width = trackWidth(st.max);
    track.style.width = width + "px";
    track.className = "afc-track " + (on ? "on" : "off");
    const left = knobLeft(st, st.value, width);
    knob.style.left = left + "px";
    fill.style.width = (on ? left + KNOB + PAD : 0) + "px";
    ticks.textContent = "";
    for (let i = 0; i <= st.max; i++) {
        const t = document.createElement("div");
        t.className = "afc-tick" + (on && i > 0 && (st.mode === "exact" ? i === st.value : i <= st.value) ? " lit" : "");
        t.style.left = (knobLeft(st, i, width) + KNOB / 2) + "px";
        ticks.appendChild(t);
    }

    const groups = listGroups(node);
    const assigned = groups.filter((g) => st.groups[groupKey(g)]).length;
    const lit = groups.filter((g) => levelOn(st, st.groups[groupKey(g)])).length;
    panelToggle.textContent = `${st.collapsed ? "▸" : "▾"} groups · ${lit}/${assigned} on · ` +
        (st.mode === "exact" ? "exact" : "cumulative");
    panel.style.display = st.collapsed ? "none" : "flex";

    if (!st.collapsed) {
        const q = (filter.value || "").trim().toLowerCase();
        list.textContent = "";
        let shown = 0;
        for (const g of groups) {
            const key = groupKey(g);
            if (q && !key.toLowerCase().includes(q)) continue;
            const level = st.groups[key] || 0;

            const row = document.createElement("div");
            row.className = "afc-grow";
            const dot = document.createElement("span");
            const live = liveGroupState(g);
            dot.className = "afc-live" + (live ? ` l-${live}` : "");
            const name = document.createElement("span");
            name.className = "afc-gname";
            name.textContent = key;
            name.title = key;

            const sel = document.createElement("select");
            sel.className = "afc-level" + (level ? " set" : "") + (levelOn(st, level) ? " lit" : "");
            sel.title = "Level: on when the value reaches it (– = never touched)";
            const top = Math.max(st.max, level);
            for (let i = 0; i <= top; i++) {
                const o = document.createElement("option");
                o.value = String(i);
                o.textContent = i ? String(i) : "–";
                sel.appendChild(o);
            }
            sel.value = String(level);
            sel.onchange = () => {
                const v = parseInt(sel.value, 10) || 0;
                if (v) st.groups[key] = v; else delete st.groups[key];
                node.afcSync();
                applyGroups(node);
                node.afcRender();
            };
            sel.addEventListener("keydown", (e) => e.stopPropagation());

            row.append(dot, name, sel);
            list.appendChild(row);
            shown += 1;
        }
        if (!shown) {
            const hint = document.createElement("div");
            hint.className = "afc-hint";
            hint.innerHTML = groups.length
                ? "No group matches the filter."
                : "No groups in this graph yet.<br>Right-click the canvas → Add Group.";
            list.appendChild(hint);
        }
        node.afcRows = Math.max(shown, 1);
    }
    fit(node);
}

function fit(node) {
    const st = node.afcState;
    const rows = st.collapsed ? 0 : node.afcRows;
    if (!st.collapsed) node.afcEls.list.style.maxHeight = Math.min(240, rows * 22 + 8) + "px";
    const fallback = st.collapsed ? 60 : 60 + Math.min(240, rows * 22 + 8) + 30;
    const minW = Math.max(300, trackWidth(st.max) + 150);
    fitToContent(node, minW, fallback, `${st.collapsed ? "c" : "o"}:${rows}:${st.max}`, false);
}

/* --------------------------------------------------------------- registro */

app.registerExtension({
    name: "AcademiaSD.FastSwitchCounter",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== T_COUNTER) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;
            node.afcUid = uid("c");

            const dataWidget = node.widgets?.find((w) => w.name === "switch_data");
            if (dataWidget) {
                dataWidget.type = "hidden";
                dataWidget.computeSize = () => [0, -4];
                dataWidget.draw = () => {};
            }
            node.afcData = dataWidget;
            node.afcState = normalize(null);
            node.afcRows = 1;
            node.afcSync = () => {
                if (node.afcData) node.afcData.value = JSON.stringify(node.afcState);
                redraw();
            };
            node.afcRender = () => {
                try { render(node); } catch (e) { console.error("[Fast Switch Counter] render", e); }
            };
            node.afcWidget = addFittedDOMWidget(node, "AFC", buildUI(node));
            node.onResize = (size) => clampToMin(node, size);
            node.afcSync();
            setTimeout(() => node.afcRender(), 60);

            // Los grupos se crean, renombran y conmutan fuera de aqui: se
            // vigila su estado para que la lista no mienta.
            let sig = "";
            node.afcTimer = setInterval(() => {
                if (!node.graph || node.flags?.collapsed) return;
                if (app.canvas?.graph && app.canvas.graph !== node.graph) return;
                let s = "";
                for (const g of listGroups(node)) s += groupKey(g) + ":" + (liveGroupState(g) || "-") + "|";
                if (s !== sig) { sig = s; node.afcRender(); }
            }, 900);
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (this.afcTimer) clearInterval(this.afcTimer);
            onRemoved?.apply(this, arguments);
        };

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function () {
            if (this.afcData && this.afcState) this.afcData.value = JSON.stringify(this.afcState);
            onSerialize?.apply(this, arguments);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            const self = this;
            const w = this.widgets?.find((x) => x.name === "switch_data");
            if (w?.value) {
                try { self.afcState = normalize(JSON.parse(w.value)); }
                catch (e) { console.error("[Fast Switch Counter] bad saved state", e); }
            }
            setTimeout(() => {
                self.afcRender();
                if (self.afcState?.opts?.applyOnLoad) applyGroups(self);
            }, 240);
        };

        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            getExtraMenuOptions?.apply(this, arguments);
            const self = this;
            options.push(null,
                { content: "Fast Switch Counter: re-apply", callback: () => applyGroups(self) },
                { content: "Fast Switch Counter: set to OFF", callback: () => setValue(self, 0) });
        };
    },
});
