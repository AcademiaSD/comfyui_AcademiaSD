// academia_switch_models.js
// Academia Switch - Models: la misma idea de modos, pero las filas no son
// grupos sino widgets de otros nodos (un unet_name, un lora_name, un clip_name,
// una strength...). Cambiar de modo reescribe esos widgets.
//
// No carga nada por su cuenta a proposito: escribe sobre los loaders que ya
// tienes en el workflow, asi que sirve igual para checkpoints, LoRAs, text
// encoders o cualquier combo, sin tener que replicar los tipos de ComfyUI.

import { app } from "../../scripts/app.js";
import {
    uid, redraw, graphOf, setWidgetValue, widgetOptions, bus, injectStyle,
    popupMenu, ensureModes, activeMode, askText,
    addFittedDOMWidget, fitToContent, clampToMin,
} from "./academia_switch_core.js";

const NODE_TYPE = "Academia_Switch_Models";
const GROUPS_TYPE = "Academia_Switch_Groups";

const SKIP = "\u0000skip";          // valor centinela del <select>: no tocar
const ROW_H = 26;
const HEAD_H = 26;
const CHROME_H = 116;
const MAX_TABLE_H = 420;
const MODE_COL_W = 150;
const NAME_COL_W = 240;

function defaultState() {
    return {
        modes: [{ id: uid(), name: "A" }, { id: uid(), name: "B" }],
        active: null,
        rows: [],
        sync: "auto",              // "auto" | "off" | "<nodeId>"
        opts: { applyOnLoad: false, autoApply: true },
    };
}

function normalize(state) {
    const s = state && typeof state === "object" ? state : {};
    const base = defaultState();
    s.modes = Array.isArray(s.modes) ? s.modes.filter((m) => m && m.id) : base.modes;
    s.rows = Array.isArray(s.rows) ? s.rows : [];
    s.sync = s.sync || "auto";
    s.opts = Object.assign({}, base.opts, s.opts || {});
    for (const r of s.rows) r.values = r.values && typeof r.values === "object" ? r.values : {};
    ensureModes(s, ["A", "B"]);
    return s;
}

/* --------------------------------------------------------------- targets */

function targetNode(node, row) {
    const graph = graphOf(node);
    return graph?.getNodeById?.(row.nodeId) || null;
}

function targetWidget(node, row) {
    return targetNode(node, row)?.widgets?.find((w) => w.name === row.widget) || null;
}

function candidates(node) {
    const graph = graphOf(node);
    const nodes = graph?._nodes || graph?.nodes || [];
    const out = [];
    for (const n of nodes) {
        if (n === node) continue;
        if (n.type === NODE_TYPE || n.type === GROUPS_TYPE) continue;
        for (const w of n.widgets || []) {
            if (!w?.name || w.type === "hidden" || w.type === "button") continue;
            const opts = widgetOptions(w);
            let kind = null;
            if (opts && opts.length) kind = "combo";
            else if (w.type === "number" || w.type === "slider") kind = "number";
            else if (typeof w.value === "boolean") kind = "toggle";
            else if (typeof w.value === "string") kind = "text";
            if (!kind) continue;
            out.push({ node: n, widget: w, kind, opts });
        }
    }
    // Los combos con pinta de fichero de modelo son lo que se busca el 95% de
    // las veces, asi que suben arriba del todo.
    const score = (c) => {
        if (c.kind !== "combo") return 2;
        const looksLikeFile = (c.opts || []).some((v) => typeof v === "string" && /\.(safetensors|ckpt|pt|pth|sft|gguf|bin)$/i.test(v));
        return looksLikeFile ? 0 : 1;
    };
    out.sort((a, b) => score(a) - score(b) || a.node.id - b.node.id);
    return out;
}

function openPicker(node, x, y) {
    document.querySelectorAll(".asw-picker").forEach((el) => el.remove());
    const list = candidates(node);

    const box = document.createElement("div");
    box.className = "asw-picker";

    const search = document.createElement("input");
    search.className = "asw-input";
    search.placeholder = "search node or widget…";
    search.style.width = "100%";
    box.appendChild(search);

    const listEl = document.createElement("div");
    listEl.className = "asw-plist";
    box.appendChild(listEl);

    const draw = () => {
        const q = search.value.trim().toLowerCase();
        listEl.textContent = "";
        let n = 0;
        for (const c of list) {
            const title = c.node.title || c.node.type;
            const hay = `#${c.node.id} ${title} ${c.widget.name}`.toLowerCase();
            if (q && !hay.includes(q)) continue;
            if (n++ > 200) break;
            const item = document.createElement("div");
            item.className = "asw-pitem";
            const a = document.createElement("span");
            a.textContent = c.widget.name;
            const b = document.createElement("span");
            b.className = "asw-pnode";
            b.textContent = `#${c.node.id} ${title}`;
            const cur = document.createElement("span");
            cur.className = "asw-pcur";
            cur.textContent = String(c.widget.value ?? "");
            item.append(a, b, cur);
            item.onclick = () => {
                box.remove();
                node.aswState.rows.push({
                    id: uid("r"),
                    nodeId: c.node.id,
                    widget: c.widget.name,
                    kind: c.kind,
                    label: `${title} › ${c.widget.name}`,
                    values: {},
                });
                node.aswSync();
                node.aswRender();
            };
            listEl.appendChild(item);
        }
        if (!n) {
            const empty = document.createElement("div");
            empty.className = "asw-empty";
            empty.textContent = list.length ? "Nothing matches." : "No other node with widgets in this graph.";
            listEl.appendChild(empty);
        }
    };
    search.addEventListener("input", draw);
    draw();

    document.body.appendChild(box);
    const r = box.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    box.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + "px";
    setTimeout(() => search.focus(), 0);

    const close = (e) => {
        if (!box.contains(e.target)) {
            box.remove();
            document.removeEventListener("mousedown", close, true);
        }
    };
    setTimeout(() => document.addEventListener("mousedown", close, true), 0);
}

/* ------------------------------------------------------------ aplicacion */

function applyMode(node, modeId, { silent = false } = {}) {
    const st = node.aswState;
    const mode = st.modes.find((m) => m.id === modeId);
    if (!mode) return;

    let ok = 0, missing = 0;
    for (const row of st.rows) {
        const v = row.values?.[modeId];
        if (v === undefined || v === null || v === SKIP) continue;
        const tn = targetNode(node, row);
        if (!tn) { missing += 1; continue; }
        if (setWidgetValue(tn, row.widget, v)) ok += 1; else missing += 1;
    }

    st.active = modeId;
    node.aswSync();
    node.aswRender();
    redraw();
    if (!silent) {
        console.log(`[Academia Switch Models] "${mode.name}": ${ok} widget(s) set` +
                    (missing ? `, ${missing} target(s) missing` : ""));
    }
}

function captureInto(node, modeId) {
    const st = node.aswState;
    let n = 0;
    for (const row of st.rows) {
        const w = targetWidget(node, row);
        if (!w) continue;
        row.values = row.values || {};
        row.values[modeId] = w.value;
        n += 1;
    }
    node.aswSync();
    node.aswRender();
    console.log(`[Academia Switch Models] captured ${n} value(s)`);
}

/* --------------------------------------------------------------- sync */

function groupsNodes(node) {
    const graph = graphOf(node);
    const nodes = graph?._nodes || graph?.nodes || [];
    return nodes.filter((n) => n.type === GROUPS_TYPE);
}

function syncSourceOf(node) {
    const st = node.aswState;
    if (st.sync === "off") return null;
    const all = groupsNodes(node);
    if (st.sync === "auto") return all[0] || null;
    return all.find((n) => String(n.id) === String(st.sync)) || null;
}

// Espeja los nombres de modo del nodo de grupos, casando por nombre para no
// perder los valores ya escritos.
function reconcileModes(node) {
    const src = syncSourceOf(node);
    if (!src?.aswState?.modes?.length) return false;
    const st = node.aswState;
    const wanted = src.aswState.modes.map((m) => String(m.name));
    const before = st.modes.map((m) => m.name).join("");

    const byName = new Map(st.modes.map((m) => [m.name, m]));
    const next = [];
    for (const name of wanted) {
        next.push(byName.get(name) || { id: uid(), name });
        byName.delete(name);
    }
    // Modos propios que el nodo de grupos no tiene: se conservan al final.
    for (const leftover of byName.values()) next.push(leftover);
    st.modes = next;
    if (!st.modes.find((m) => m.id === st.active)) st.active = st.modes[0]?.id;
    return before !== st.modes.map((m) => m.name).join("");
}

/* ------------------------------------------------------------------- UI */

function buildUI(node) {
    injectStyle();
    const root = document.createElement("div");
    root.className = "asw-root";

    const top = document.createElement("div");
    top.className = "asw-bar";

    const syncLabel = document.createElement("span");
    syncLabel.textContent = "🔗";
    syncLabel.title = "Follow the mode of an Academia Switch · Groups node";

    const syncSel = document.createElement("select");
    syncSel.className = "asw-sel asw-bar-grow";
    syncSel.onchange = () => {
        node.aswState.sync = syncSel.value;
        reconcileModes(node);
        node.aswSync();
        node.aswRender();
    };

    const btnAdd = document.createElement("button");
    btnAdd.className = "asw-btn";
    btnAdd.textContent = "+ Add model";
    btnAdd.title = "Pick a widget of any node in the graph (unet, lora, clip, vae, strength…)";
    btnAdd.onclick = (e) => openPicker(node, e.clientX, e.clientY);

    const btnMode = document.createElement("button");
    btnMode.className = "asw-btn";
    btnMode.textContent = "+ Mode";
    btnMode.onclick = () => {
        const name = askText("Name of the new mode:", `M${node.aswState.modes.length + 1}`);
        if (!name) return;
        node.aswState.modes.push({ id: uid(), name });
        node.aswSync();
        node.aswRender();
    };

    const btnOpts = document.createElement("button");
    btnOpts.className = "asw-btn";
    btnOpts.textContent = "⚙";
    btnOpts.onclick = (e) => {
        const o = node.aswState.opts;
        const tick = (v) => (v ? "☑ " : "☐ ");
        popupMenu(e.clientX, e.clientY, [
            { head: "Options" },
            { content: tick(o.autoApply) + "Apply on mode click", callback: () => { o.autoApply = !o.autoApply; node.aswSync(); } },
            { content: tick(o.applyOnLoad) + "Apply active mode on load", callback: () => { o.applyOnLoad = !o.applyOnLoad; node.aswSync(); } },
            "-",
            { content: "🎯 Re-point rows to nodes by title", callback: () => repoint(node) },
            { content: "🧹 Remove rows whose node is gone", callback: () => {
                const st = node.aswState;
                st.rows = st.rows.filter((r) => targetNode(node, r));
                node.aswSync(); node.aswRender();
            } },
        ]);
    };

    top.append(syncLabel, syncSel, btnAdd, btnMode, btnOpts);
    root.appendChild(top);

    const scroll = document.createElement("div");
    scroll.className = "asw-scroll";
    const table = document.createElement("table");
    table.className = "asw-table";
    scroll.appendChild(table);
    root.appendChild(scroll);

    const bottom = document.createElement("div");
    bottom.className = "asw-bar";
    const btnCapture = document.createElement("button");
    btnCapture.className = "asw-btn";
    btnCapture.textContent = "📸 Capture";
    btnCapture.title = "Store the current value of every row into the active mode";
    btnCapture.onclick = () => captureInto(node, node.aswState.active);
    const btnApply = document.createElement("button");
    btnApply.className = "asw-btn asw-primary asw-bar-grow";
    btnApply.textContent = "▶ Apply";
    btnApply.onclick = () => applyMode(node, node.aswState.active);
    bottom.append(btnCapture, btnApply);
    root.appendChild(bottom);

    const legend = document.createElement("div");
    legend.className = "asw-legend";
    legend.innerHTML = "<span>— leave as is</span><span style=\"margin-left:auto\">📸 fills the active column from the graph</span>";
    root.appendChild(legend);

    for (const ev of ["mousedown", "pointerdown", "wheel", "contextmenu"]) {
        root.addEventListener(ev, (e) => e.stopPropagation());
    }

    node.aswEls = { root, table, syncSel, btnApply, btnCapture };
    return root;
}

// Los ids de nodo cambian al copiar y pegar un workflow entre pestanas; volver
// a engancharlos por titulo salva la configuracion sin rehacerla a mano.
function repoint(node) {
    const graph = graphOf(node);
    const nodes = graph?._nodes || graph?.nodes || [];
    let fixed = 0;
    for (const row of node.aswState.rows) {
        if (targetWidget(node, row)) continue;
        const wantedTitle = String(row.label || "").split(" › ")[0];
        const cand = nodes.find((n) =>
            (n.title || n.type) === wantedTitle && n.widgets?.some((w) => w.name === row.widget));
        if (cand) { row.nodeId = cand.id; fixed += 1; }
    }
    node.aswSync();
    node.aswRender();
    console.log(`[Academia Switch Models] re-pointed ${fixed} row(s)`);
}

function renderTable(node) {
    const st = node.aswState;
    const { table, syncSel, btnApply } = node.aswEls;

    reconcileModes(node);

    /* selector de sincronizacion */
    const srcs = groupsNodes(node);
    const wanted = st.sync;
    syncSel.textContent = "";
    const addOpt = (value, label) => {
        const o = document.createElement("option");
        o.value = value; o.textContent = label;
        if (String(value) === String(wanted)) o.selected = true;
        syncSel.appendChild(o);
    };
    addOpt("auto", srcs.length ? `Auto → #${srcs[0].id} ${srcs[0].title || "Groups"}` : "Auto (no Groups node)");
    addOpt("off", "Standalone");
    for (const s of srcs) addOpt(String(s.id), `#${s.id} ${s.title || "Groups"}`);

    const active = activeMode(st);
    btnApply.textContent = active ? `▶ Apply "${active.name}"` : "▶ Apply";

    table.textContent = "";

    const thead = document.createElement("thead");
    thead.className = "asw-thead";
    const hr = document.createElement("tr");
    const thName = document.createElement("th");
    thName.className = "asw-th-name";
    thName.textContent = "Target widget";
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
        th.onclick = (e) => {
            if (e.target === dots) { openModeMenu(node, m, idx, e); return; }
            if (st.opts.autoApply) applyMode(node, m.id);
            else { st.active = m.id; node.aswSync(); node.aswRender(); }
        };
        th.oncontextmenu = (e) => { e.preventDefault(); openModeMenu(node, m, idx, e); };
        hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of st.rows) {
        const tn = targetNode(node, row);
        const w = tn?.widgets?.find((x) => x.name === row.widget) || null;

        const tr = document.createElement("tr");
        tr.className = "asw-row";

        const tdName = document.createElement("td");
        tdName.className = "asw-name";
        const del = document.createElement("span");
        del.className = "asw-x";
        del.textContent = "✕";
        del.title = "Remove this row";
        del.onclick = () => {
            st.rows = st.rows.filter((r) => r !== row);
            node.aswSync(); node.aswRender();
        };
        const name = document.createElement("span");
        name.textContent = row.label || `${row.nodeId} › ${row.widget}`;
        if (!w) {
            name.style.color = "#f85149";
            tdName.title = `Node #${row.nodeId} / widget "${row.widget}" not found. ⚙ → Re-point rows.`;
        } else {
            tdName.title = `#${tn.id} ${tn.title || tn.type} › ${row.widget}  (now: ${w.value})`;
            name.onclick = () => {          // llevar la vista al nodo apuntado
                try { app.canvas.centerOnNode(tn); redraw(); } catch (e) {}
            };
            name.style.cursor = "pointer";
        }
        tdName.append(del, name);
        tr.appendChild(tdName);

        for (const m of st.modes) {
            const td = document.createElement("td");
            td.className = "asw-cell";
            td.style.padding = "2px 4px";
            const stored = row.values?.[m.id];
            const opts = w ? widgetOptions(w) : null;

            if (opts) {
                const sel = document.createElement("select");
                sel.className = "asw-sel";
                const skipOpt = document.createElement("option");
                skipOpt.value = SKIP;
                skipOpt.textContent = "—";
                sel.appendChild(skipOpt);
                const values = opts.slice();
                if (stored !== undefined && !values.includes(stored)) values.push(stored);
                for (const v of values) {
                    const o = document.createElement("option");
                    o.value = String(v);
                    o.textContent = opts.includes(v) ? String(v) : `${v}  (missing)`;
                    sel.appendChild(o);
                }
                sel.value = stored === undefined ? SKIP : String(stored);
                if (stored === undefined) sel.classList.add("asw-unset");
                sel.onchange = () => {
                    row.values = row.values || {};
                    if (sel.value === SKIP) delete row.values[m.id];
                    else row.values[m.id] = sel.value;
                    node.aswSync();
                    node.aswRender();
                };
                td.appendChild(sel);
            } else if (w && typeof w.value === "boolean") {
                const sel = document.createElement("select");
                sel.className = "asw-sel";
                for (const [v, t] of [[SKIP, "—"], ["true", "on"], ["false", "off"]]) {
                    const o = document.createElement("option");
                    o.value = v; o.textContent = t;
                    sel.appendChild(o);
                }
                sel.value = stored === undefined ? SKIP : String(!!stored);
                sel.onchange = () => {
                    row.values = row.values || {};
                    if (sel.value === SKIP) delete row.values[m.id];
                    else row.values[m.id] = sel.value === "true";
                    node.aswSync(); node.aswRender();
                };
                td.appendChild(sel);
            } else {
                const inp = document.createElement("input");
                inp.className = "asw-sel";
                inp.type = (row.kind === "number" || typeof w?.value === "number") ? "number" : "text";
                if (inp.type === "number") inp.step = "any";
                inp.placeholder = "—";
                inp.value = stored === undefined ? "" : String(stored);
                inp.onchange = () => {
                    row.values = row.values || {};
                    const raw = inp.value.trim();
                    if (!raw) delete row.values[m.id];
                    else row.values[m.id] = inp.type === "number" ? Number(raw) : raw;
                    node.aswSync();
                };
                td.appendChild(inp);
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }

    if (!st.rows.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = st.modes.length + 1;
        td.className = "asw-empty";
        td.innerHTML = "No target yet.<br><b>+ Add model</b> picks any widget of any node<br>(unet, checkpoint, lora, clip, vae, a strength…).";
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    node.aswRows = Math.max(st.rows.length, 1);
    fitSize(node);
}

function openModeMenu(node, mode, idx, e) {
    const st = node.aswState;
    popupMenu(e.clientX, e.clientY, [
        { head: `Mode "${mode.name}"` },
        { content: "▶  Apply now", callback: () => applyMode(node, mode.id) },
        { content: "📸  Capture current values", callback: () => { st.active = mode.id; captureInto(node, mode.id); } },
        "-",
        { content: "✎  Rename", callback: () => {
            const n = askText("New name:", mode.name);
            if (n) { mode.name = n; node.aswSync(); node.aswRender(); }
        } },
        { content: "·  Clear column", callback: () => {
            for (const r of st.rows) delete r.values?.[mode.id];
            node.aswSync(); node.aswRender();
        } },
        "-",
        { content: "🗑  Delete mode", callback: () => {
            if (st.modes.length <= 1) { alert("At least one mode is needed."); return; }
            if (!window.confirm(`Delete mode "${mode.name}"?`)) return;
            st.modes.splice(idx, 1);
            for (const r of st.rows) delete r.values?.[mode.id];
            if (st.active === mode.id) st.active = st.modes[0].id;
            node.aswSync(); node.aswRender();
        } },
    ]);
}

function fitSize(node) {
    const st = node.aswState;
    const w = Math.max(380, NAME_COL_W + st.modes.length * MODE_COL_W + 24);
    const fallback = CHROME_H + Math.min(MAX_TABLE_H, HEAD_H + node.aswRows * ROW_H + 6);
    fitToContent(node, w, fallback, `${node.aswRows}:${st.modes.length}`, false);
}

/* ----------------------------------------------------------- extension */

app.registerExtension({
    name: "AcademiaSD.SwitchModels",

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
                try { renderTable(self); } catch (e) { console.error("[Academia Switch Models] render", e); }
            };

            addFittedDOMWidget(this, "ASW", buildUI(this));
            this.size = [560, 260];
            this.onResize = function (size) { clampToMin(self, size); };

            // Un nodo de grupos ha cambiado de modo: si lo seguimos, aplicamos
            // el modo del mismo nombre.
            this.aswUnsub = bus.on((evt) => {
                if (evt?.type !== "mode") return;
                const src = syncSourceOf(self);
                if (!src || String(src.id) !== String(evt.sourceId)) return;
                reconcileModes(self);
                const m = self.aswState.modes.find(
                    (x) => String(x.name).toLowerCase() === String(evt.modeName).toLowerCase());
                if (m) applyMode(self, m.id, { silent: true });
                else console.warn(`[Academia Switch Models] no mode named "${evt.modeName}" here`);
            });

            this.aswSync();
            setTimeout(() => self.aswRender(), 80);
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try { this.aswUnsub?.(); } catch (e) {}
            onRemoved?.apply(this, arguments);
        };

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function () {
            if (this.aswData && this.aswState) this.aswData.value = JSON.stringify(this.aswState);
            onSerialize?.apply(this, arguments);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            const self = this;
            const w = this.widgets?.find((x) => x.name === "switch_data");
            if (w?.value) {
                try { this.aswState = normalize(JSON.parse(w.value)); }
                catch (e) { console.error("[Academia Switch Models] bad saved state", e); }
            }
            setTimeout(() => {
                self.aswRender?.();
                if (self.aswState?.opts?.applyOnLoad) applyMode(self, self.aswState.active);
            }, 260);
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
            }, {
                content: "Academia Switch: re-point rows",
                callback: () => repoint(self),
            });
        };
    },
});
