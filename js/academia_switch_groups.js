// academia_switch_groups.js
// Academia Switch - Groups: matriz Grupos x Modos.
// Cada celda dice que le pasa a ese grupo cuando ese modo esta activo:
//   ▶ activo   ⇝ bypass   ✕ mute   · ignorar (el modo no lo toca)
// El punto de "ignorar" es que un modo pueda encender lo suyo sin obligarte a
// declarar el resto del workflow.

import { app } from "../../scripts/app.js";
import {
    CELL_ORDER, CELL_META, uid, redraw, listGroups, groupKey, liveGroupState,
    setGroupState, bus, injectStyle, popupMenu, ensureModes, activeMode, askText,
    addFittedDOMWidget, fitToContent, clampToMin,
} from "./academia_switch_core.js";

const NODE_TYPE = "Academia_Switch_Groups";

const ROW_H = 23;
const HEAD_H = 26;
const CHROME_H = 116;      // barra superior + barra inferior + leyenda + margenes
const MAX_TABLE_H = 420;
const MODE_COL_W = 68;
const NAME_COL_W = 210;

function defaultState() {
    return {
        modes: [{ id: uid(), name: "A" }, { id: uid(), name: "B" }],
        active: null,
        rules: {},                 // { groupTitle: { modeId: cell } }
        opts: {
            applyOnLoad: false,
            onlyAssigned: false,
            autoApply: true,
            exclusive: false,
            alpha: false,
        },
    };
}

function normalize(state) {
    const s = state && typeof state === "object" ? state : {};
    const base = defaultState();
    s.modes = Array.isArray(s.modes) ? s.modes.filter((m) => m && m.id) : base.modes;
    s.rules = s.rules && typeof s.rules === "object" ? s.rules : {};
    s.opts = Object.assign({}, base.opts, s.opts || {});
    ensureModes(s, ["A", "B"]);
    return s;
}

/* ------------------------------------------------------------- aplicacion */

function applyMode(node, modeId, { silent = false } = {}) {
    const st = node.aswState;
    const mode = st.modes.find((m) => m.id === modeId);
    if (!mode) return;

    let touched = 0;
    for (const g of listGroups(node)) {
        const cell = st.rules[groupKey(g)]?.[modeId] || "skip";
        if (cell === "skip") continue;
        touched += setGroupState(g, cell);
    }

    st.active = modeId;
    node.aswSync();
    redraw();

    if (!silent) {
        console.log(`[Academia Switch] "${mode.name}" applied (${touched} node(s) changed)`);
        bus.emit({ type: "mode", sourceId: node.id, sourceTitle: node.title, modeName: mode.name });
    }
}

function captureInto(node, modeId) {
    const st = node.aswState;
    let n = 0;
    for (const g of listGroups(node)) {
        const live = liveGroupState(g);
        if (!live || live === "mixed") continue;    // grupo vacio o a medias: no se inventa nada
        const key = groupKey(g);
        (st.rules[key] = st.rules[key] || {})[modeId] = live;
        n += 1;
    }
    node.aswSync();
    node.aswRender();
    console.log(`[Academia Switch] captured ${n} group(s) into the current mode`);
}

/* ------------------------------------------------------------------- UI */

function buildUI(node) {
    injectStyle();

    const root = document.createElement("div");
    root.className = "asw-root";

    /* --- barra superior --- */
    const top = document.createElement("div");
    top.className = "asw-bar";

    const filter = document.createElement("input");
    filter.className = "asw-input";
    filter.placeholder = "filter groups…";
    filter.addEventListener("input", () => node.aswRender());

    const btnAddMode = document.createElement("button");
    btnAddMode.className = "asw-btn";
    btnAddMode.textContent = "+ Mode";
    btnAddMode.title = "Add a new mode column";
    btnAddMode.onclick = () => {
        const name = askText("Name of the new mode:", `M${node.aswState.modes.length + 1}`);
        if (!name) return;
        const m = { id: uid(), name };
        node.aswState.modes.push(m);
        node.aswSync();
        node.aswRender();
    };

    const btnOpts = document.createElement("button");
    btnOpts.className = "asw-btn";
    btnOpts.textContent = "⚙";
    btnOpts.title = "Options";
    btnOpts.onclick = (e) => {
        const o = node.aswState.opts;
        const tick = (v) => (v ? "☑ " : "☐ ");
        popupMenu(e.clientX, e.clientY, [
            { head: "Options" },
            { content: tick(o.autoApply) + "Apply on mode click", callback: () => { o.autoApply = !o.autoApply; node.aswSync(); } },
            { content: tick(o.applyOnLoad) + "Apply active mode on load", callback: () => { o.applyOnLoad = !o.applyOnLoad; node.aswSync(); } },
            { content: tick(o.exclusive) + "Exclusive rows (▶ bypasses the rest)", callback: () => { o.exclusive = !o.exclusive; node.aswSync(); } },
            { content: tick(o.onlyAssigned) + "Hide unassigned groups", callback: () => { o.onlyAssigned = !o.onlyAssigned; node.aswSync(); node.aswRender(); } },
            { content: tick(o.alpha) + "Sort groups alphabetically", callback: () => { o.alpha = !o.alpha; node.aswSync(); node.aswRender(); } },
            "-",
            { content: "🧹 Clear the whole matrix", callback: () => {
                if (!window.confirm("Clear every cell of the matrix?")) return;
                node.aswState.rules = {};
                node.aswSync(); node.aswRender();
            } },
        ]);
    };

    top.append(filter, btnAddMode, btnOpts);
    root.appendChild(top);

    /* --- tabla --- */
    const scroll = document.createElement("div");
    scroll.className = "asw-scroll";
    const table = document.createElement("table");
    table.className = "asw-table";
    scroll.appendChild(table);
    root.appendChild(scroll);

    /* --- barra inferior --- */
    const bottom = document.createElement("div");
    bottom.className = "asw-bar";

    const btnCapture = document.createElement("button");
    btnCapture.className = "asw-btn";
    btnCapture.textContent = "📸 Capture";
    btnCapture.title = "Store the current state of every group into the active mode";
    btnCapture.onclick = () => captureInto(node, node.aswState.active);

    const btnApply = document.createElement("button");
    btnApply.className = "asw-btn asw-primary asw-bar-grow";
    btnApply.textContent = "▶ Apply";
    btnApply.onclick = () => applyMode(node, node.aswState.active);

    bottom.append(btnCapture, btnApply);
    root.appendChild(bottom);

    const legend = document.createElement("div");
    legend.className = "asw-legend";
    legend.innerHTML =
        '<span style="color:#3fb950">▶ active</span>' +
        '<span style="color:#c39bff">⇝ bypass</span>' +
        '<span style="color:#f85149">✕ mute</span>' +
        "<span>· ignore</span>" +
        "<span style=\"margin-left:auto\">click cycles · right-click picks</span>";
    root.appendChild(legend);

    // El canvas de LiteGraph se traga los eventos si no los paramos aqui.
    for (const ev of ["mousedown", "pointerdown", "wheel", "contextmenu"]) {
        root.addEventListener(ev, (e) => e.stopPropagation());
    }

    node.aswEls = { root, table, filter, btnApply, btnCapture };
    return root;
}

function renderTable(node) {
    const st = node.aswState;
    const { table, filter, btnApply, btnCapture } = node.aswEls;
    const q = (filter.value || "").trim().toLowerCase();

    const active = activeMode(st);
    btnApply.textContent = active ? `▶ Apply "${active.name}"` : "▶ Apply";
    btnCapture.title = active
        ? `Store the current state of every group into "${active.name}"`
        : "Store the current state of every group";

    table.textContent = "";

    /* cabecera */
    const thead = document.createElement("thead");
    thead.className = "asw-thead";
    const hr = document.createElement("tr");
    const thName = document.createElement("th");
    thName.className = "asw-th-name";
    thName.textContent = "Group";
    hr.appendChild(thName);

    st.modes.forEach((m, idx) => {
        const th = document.createElement("th");
        th.className = "asw-mode-h" + (m.id === st.active ? " asw-active" : "");
        const chip = document.createElement("div");
        chip.className = "asw-chip";
        const label = document.createElement("span");
        label.textContent = m.name;
        const dots = document.createElement("span");
        dots.className = "asw-dots";
        dots.textContent = "⋮";
        chip.append(label, dots);
        th.appendChild(chip);
        th.title = `Click: make "${m.name}" the active mode · ⋮ / right-click: mode menu`;

        th.onclick = (e) => {
            if (e.target === dots) { openModeMenu(node, m, idx, e); return; }
            if (st.opts.autoApply) applyMode(node, m.id);
            else { st.active = m.id; node.aswSync(); }
            node.aswRender();
        };
        th.oncontextmenu = (e) => { e.preventDefault(); openModeMenu(node, m, idx, e); };
        hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    /* filas */
    const tbody = document.createElement("tbody");
    const groups = listGroups(node);
    const byKey = new Map();
    for (const g of groups) {
        const k = groupKey(g);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(g);
    }
    let keys = Array.from(byKey.keys());
    // Claves guardadas cuyo grupo ya no existe: se siguen mostrando para que
    // puedas verlas y limpiarlas en vez de que desaparezcan en silencio.
    for (const k of Object.keys(st.rules)) if (!byKey.has(k)) keys.push(k);
    if (st.opts.alpha) keys.sort((a, b) => a.localeCompare(b));

    let shown = 0;
    for (const key of keys) {
        if (q && !key.toLowerCase().includes(q)) continue;
        const rule = st.rules[key] || {};
        if (st.opts.onlyAssigned && !st.modes.some((m) => rule[m.id] && rule[m.id] !== "skip")) continue;

        const gs = byKey.get(key);
        const missing = !gs;
        const tr = document.createElement("tr");
        tr.className = "asw-row";

        const tdName = document.createElement("td");
        tdName.className = "asw-name";
        const dot = document.createElement("span");
        const live = missing ? null : liveGroupState(gs[0]);
        dot.className = "asw-live" + (live ? ` l-${live}` : "");
        const nameSpan = document.createElement("span");
        nameSpan.textContent = key + (gs && gs.length > 1 ? `  ×${gs.length}` : "");
        if (missing) {
            nameSpan.style.color = "#6e7681";
            nameSpan.style.textDecoration = "line-through";
            tdName.title = "This group is not in the graph any more";
        } else {
            tdName.title = `${key} — ${gs.reduce((a, g) => a + (g.nodes?.length || 0), 0)} node(s)`;
        }
        tdName.append(dot, nameSpan);
        tr.appendChild(tdName);

        for (const m of st.modes) {
            const cur = rule[m.id] || "skip";
            const meta = CELL_META[cur];
            const td = document.createElement("td");
            td.className = "asw-cell";
            const span = document.createElement("span");
            span.className = meta.cls;
            span.textContent = meta.glyph;
            td.appendChild(span);
            td.title = meta.tip;

            td.onclick = (e) => {
                const dir = e.shiftKey ? -1 : 1;
                const next = CELL_ORDER[(CELL_ORDER.indexOf(cur) + dir + CELL_ORDER.length) % CELL_ORDER.length];
                setCell(node, key, m.id, next);
            };
            td.oncontextmenu = (e) => {
                e.preventDefault();
                popupMenu(e.clientX, e.clientY, [
                    { head: key },
                    ...CELL_ORDER.map((c) => ({
                        content: `${CELL_META[c].glyph}  ${CELL_META[c].label}`,
                        callback: () => setCell(node, key, m.id, c),
                    })),
                    "-",
                    { content: "Same in every mode", callback: () => {
                        for (const mm of st.modes) (st.rules[key] = st.rules[key] || {})[mm.id] = cur;
                        node.aswSync(); node.aswRender();
                    } },
                    { content: "🗑 Forget this row", callback: () => {
                        delete st.rules[key]; node.aswSync(); node.aswRender();
                    } },
                ]);
            };
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
        shown += 1;
    }

    if (!shown) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = st.modes.length + 1;
        td.className = "asw-empty";
        td.innerHTML = groups.length
            ? "No group matches the filter."
            : "No groups in this graph yet.<br>Create groups (right-click the canvas → Add Group)<br>and they will show up here.";
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    node.aswRows = Math.max(shown, 1);
    fitSize(node);
}

function setCell(node, key, modeId, value) {
    const st = node.aswState;
    const rule = (st.rules[key] = st.rules[key] || {});
    rule[modeId] = value;
    if (value === "on" && st.opts.exclusive) {
        for (const m of st.modes) if (m.id !== modeId) rule[m.id] = "bypass";
    }
    if (value === "skip") delete rule[modeId];
    node.aswSync();
    node.aswRender();
}

function openModeMenu(node, mode, idx, e) {
    const st = node.aswState;
    const move = (delta) => {
        const to = idx + delta;
        if (to < 0 || to >= st.modes.length) return;
        st.modes.splice(to, 0, st.modes.splice(idx, 1)[0]);
        node.aswSync(); node.aswRender();
    };
    const fill = (cell) => {
        for (const g of listGroups(node)) {
            const k = groupKey(g);
            const rule = (st.rules[k] = st.rules[k] || {});
            if (cell === "skip") delete rule[mode.id];
            else rule[mode.id] = cell;
        }
        node.aswSync(); node.aswRender();
    };
    popupMenu(e.clientX, e.clientY, [
        { head: `Mode "${mode.name}"` },
        { content: "▶  Apply now", callback: () => { applyMode(node, mode.id); node.aswRender(); } },
        { content: "📸  Capture current graph state", callback: () => { st.active = mode.id; captureInto(node, mode.id); } },
        "-",
        { content: "✎  Rename", callback: () => {
            const n = askText("New name:", mode.name);
            if (n) { mode.name = n; node.aswSync(); node.aswRender(); }
        } },
        { content: "⧉  Duplicate", callback: () => {
            const copy = { id: uid(), name: mode.name + " copy" };
            st.modes.splice(idx + 1, 0, copy);
            for (const k of Object.keys(st.rules)) {
                if (st.rules[k][mode.id]) st.rules[k][copy.id] = st.rules[k][mode.id];
            }
            node.aswSync(); node.aswRender();
        } },
        { content: "←  Move left", callback: () => move(-1) },
        { content: "→  Move right", callback: () => move(1) },
        "-",
        { head: "Fill column" },
        { content: "▶  all active", callback: () => fill("on") },
        { content: "⇝  all bypass", callback: () => fill("bypass") },
        { content: "✕  all mute", callback: () => fill("mute") },
        { content: "·  all ignore", callback: () => fill("skip") },
        "-",
        { content: "🗑  Delete mode", callback: () => {
            if (st.modes.length <= 1) { alert("At least one mode is needed."); return; }
            if (!window.confirm(`Delete mode "${mode.name}"?`)) return;
            st.modes.splice(idx, 1);
            for (const k of Object.keys(st.rules)) delete st.rules[k][mode.id];
            if (st.active === mode.id) st.active = st.modes[0].id;
            node.aswSync(); node.aswRender();
        } },
    ]);
}

function fitSize(node) {
    const st = node.aswState;
    const w = Math.max(320, NAME_COL_W + st.modes.length * MODE_COL_W + 24);
    const fallback = CHROME_H + Math.min(MAX_TABLE_H, HEAD_H + node.aswRows * ROW_H + 4);
    fitToContent(node, w, fallback, `${node.aswRows}:${st.modes.length}`, false);
}

/* ----------------------------------------------------------- extension */

app.registerExtension({
    name: "AcademiaSD.SwitchGroups",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const self = this;

            const dataWidget = this.widgets?.find((w) => w.name === "switch_data");
            if (dataWidget) {
                dataWidget.type = "hidden";
                dataWidget.computeSize = () => [0, -4];
                dataWidget.draw = () => {};
            }
            this.aswData = dataWidget;

            this.aswState = normalize(null);
            this.aswRows = 1;

            this.aswSync = function () {
                if (self.aswData) self.aswData.value = JSON.stringify(self.aswState);
                redraw();
            };
            this.aswRender = function () {
                try { renderTable(self); } catch (e) { console.error("[Academia Switch] render", e); }
            };

            addFittedDOMWidget(this, "ASW", buildUI(this));
            this.size = [420, 300];

            this.onResize = function (size) { clampToMin(self, size); };

            // Los grupos se crean, se renombran y se mueven fuera de este nodo,
            // asi que hay que volver a mirarlos cada poco. La firma barata evita
            // repintar 24 veces por segundo sin motivo.
            let sig = "";
            this.aswTimer = setInterval(() => {
                // Solo cuando el nodo esta a la vista: recorrer los grupos es
                // barato pero no gratis, y no hace falta hacerlo dentro de un
                // subgrafo que no estas mirando ni con el nodo plegado.
                if (!self.graph || self.flags?.collapsed) return;
                if (app.canvas?.graph && app.canvas.graph !== self.graph) return;
                let s = "";
                for (const g of listGroups(self)) s += groupKey(g) + ":" + (liveGroupState(g) || "-") + "|";
                s += self.aswState.modes.length;
                if (s !== sig) { sig = s; self.aswRender(); }
            }, 900);

            this.aswSync();
            setTimeout(() => self.aswRender(), 60);
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            if (this.aswTimer) clearInterval(this.aswTimer);
            onRemoved?.apply(this, arguments);
        };

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            if (this.aswData && this.aswState) this.aswData.value = JSON.stringify(this.aswState);
            onSerialize?.apply(this, arguments);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (o) {
            onConfigure?.apply(this, arguments);
            const self = this;
            const w = this.widgets?.find((x) => x.name === "switch_data");
            if (w?.value) {
                try { this.aswState = normalize(JSON.parse(w.value)); }
                catch (e) { console.error("[Academia Switch] bad saved state", e); }
            }
            setTimeout(() => {
                self.aswRender?.();
                if (self.aswState?.opts?.applyOnLoad) applyMode(self, self.aswState.active);
            }, 220);
        };

        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            getExtraMenuOptions?.apply(this, arguments);
            const self = this;
            options.push(null, {
                content: "Academia Switch: apply active mode",
                callback: () => applyMode(self, self.aswState.active),
            }, {
                content: "Academia Switch: capture into active mode",
                callback: () => captureInto(self, self.aswState.active),
            });
        };
    },
});
