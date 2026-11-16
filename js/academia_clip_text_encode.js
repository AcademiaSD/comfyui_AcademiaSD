import { app } from "../../scripts/app.js";

/* Estilos compartidos por todos los nodos de prompt: la vista previa flotante,
   el menu de "mover a grupo" y el propio panel. Se inyectan una sola vez.
   Shared styles for every prompt node, injected once. */
let asdStylesDone = false;
function asdEnsureStyles() {
    if (asdStylesDone) return;
    asdStylesDone = true;
    const style = document.createElement("style");
    style.textContent = `
        .asd-prompt-preview {
            position: fixed; z-index: 10000; display: none;
            max-width: 520px; max-height: 340px; overflow-y: auto;
            padding: 8px 10px; box-sizing: border-box;
            background: #101010; color: #ddd;
            border: 1px solid #4a6ee0; border-radius: 4px;
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6);
            font-family: monospace; font-size: 11px; line-height: 1.45;
            white-space: pre-wrap; overflow-wrap: anywhere;
        }
        .asd-prompt-preview::-webkit-scrollbar, .asd-prompt-menu::-webkit-scrollbar { width: 8px; }
        .asd-prompt-preview::-webkit-scrollbar-track, .asd-prompt-menu::-webkit-scrollbar-track { background: #1a1a1a; }
        .asd-prompt-preview::-webkit-scrollbar-thumb, .asd-prompt-menu::-webkit-scrollbar-thumb { background: #4a6ee0; border-radius: 4px; }

        .asd-prompt-menu {
            position: fixed; z-index: 10001; min-width: 160px; max-width: 280px;
            max-height: 260px; overflow-y: auto; padding: 3px 0; box-sizing: border-box;
            background: #181818; color: #ddd; border: 1px solid #4a6ee0; border-radius: 4px;
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6); font-family: sans-serif; font-size: 11px;
        }
        .asd-prompt-menu-title { padding: 3px 10px 4px; color: #888; font-size: 10px; border-bottom: 1px solid #333; margin-bottom: 2px; }
        .asd-prompt-menu-item { padding: 4px 10px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .asd-prompt-menu-item:hover { background: #4a6ee0; color: #fff; }
        .asd-prompt-menu-empty { padding: 4px 10px; color: #666; }

        .asd-p-root {
            padding: 4px; background: #222; border-radius: 4px;
            font-family: sans-serif; font-size: 10px; display: flex;
            flex-direction: column; gap: 4px; width: 100%; height: 100%;
            box-sizing: border-box; color: #fff; overflow: hidden;
        }
        .asd-p-textarea {
            width: 100%; flex: 1 1 0; min-height: 40px; resize: none; background: #111; color: #fff;
            border: 1px solid #444; border-radius: 3px; padding: 5px;
            font-family: monospace; font-size: 11px; outline: none; box-sizing: border-box;
        }
        .asd-p-row { display: flex; gap: 3px; align-items: center; flex-shrink: 0; }
        .asd-p-label { color: #aaa; font-size: 9px; }
        .asd-p-btn {
            cursor: pointer; padding: 2px 5px; color: #ddd;
            border: 1px solid #444; border-radius: 2px;
            font-size: 9px; background: #2a2a2a; font-weight: bold; white-space: nowrap;
            transition: background 0.1s, border-color 0.1s;
        }
        .asd-p-btn:hover { background: #3a3a3a; border-color: #666; }
        .asd-p-btn.asd-p-red { background: #5a2222; border-color: #7b2a2a; }
        .asd-p-btn.asd-p-red:hover { background: #7b2a2a; }
        .asd-p-btn.asd-p-tab { flex: 0 0 auto; }
        .asd-p-btn.asd-p-tab.active { background: #4a6ee0; border-color: #4a6ee0; color: #fff; }
        .asd-p-btn:disabled { opacity: 0.35; cursor: default; }
        .asd-p-input {
            padding: 2px 4px; background: #111; color: #fff;
            border: 1px solid #444; border-radius: 2px; font-size: 10px; box-sizing: border-box;
        }
        .asd-p-extended {
            display: none; flex-direction: column; gap: 4px; flex: 0 1 auto; min-height: 0;
            border-top: 1px solid #444; padding-top: 4px;
        }
        .asd-p-splitter {
            height: 5px; background: #333; cursor: row-resize; border-radius: 2px;
            flex-shrink: 0; transition: background 0.15s;
            display: flex; align-items: center; justify-content: center;
        }
        .asd-p-splitter:hover, .asd-p-splitter.dragging { background: #4a6ee0; }
        .asd-p-splitter::after { content: ""; width: 20px; height: 1px; background: #666; }
        .asd-p-tray {
            flex: 0 1 80px; min-height: 30px; overflow-y: auto;
            display: flex; flex-direction: column; gap: 2px;
            background: #111; padding: 2px; border-radius: 2px; border: 1px solid #333;
        }
        .asd-p-empty { text-align: center; padding: 10px; color: #666; font-size: 9px; }
        .asd-p-card {
            display: flex; justify-content: space-between; align-items: center; gap: 4px;
            padding: 2px 5px; background: #1a1a1a; border-radius: 2px;
            border-left: 3px solid #4a6ee0; font-size: 10px;
            height: 22px; min-height: 22px; box-sizing: border-box; flex-shrink: 0; overflow: hidden;
        }
        .asd-p-card.recent { border-left-color: #777; }
        .asd-p-card-text {
            font-family: monospace; color: #ccc; white-space: nowrap;
            overflow: hidden; text-overflow: ellipsis; flex: 1; line-height: 18px;
        }
        .asd-p-card-btns { display: flex; gap: 2px; flex-shrink: 0; }
    `;
    document.head.appendChild(style);
}


/* ── VISTA PREVIA DEL PROMPT AL PASAR EL PUNTERO ──────────────────────────────
   El title="" nativo recorta el texto, lo pinta en una sola tira y no se puede
   desplazar, que es justo lo que hace falta con un prompt de varias lineas.
   Este panel flotante muestra el prompt entero y SE PUEDE RECORRER: por eso no
   se cierra al entrar el puntero en el, solo al salir de la tarjeta Y del panel.

   Vive en document.body y no dentro de la tarjeta, porque la bandeja tiene
   overflow oculto y ahi dentro quedaria recortado.

   The native title="" truncates, renders as one strip and cannot be scrolled --
   exactly what a multi-line prompt needs. This floating panel shows the whole
   prompt and can be scrolled, so it stays open while the pointer is inside it
   and closes only when the pointer has left both the card and the panel. It
   lives on document.body rather than inside the card because the tray clips its
   overflow and it would be cut off in there. */
let asdPreviewEl = null;
let asdPreviewTimer = null;

function asdPreviewPanel() {
    if (asdPreviewEl) return asdPreviewEl;
    asdEnsureStyles();

    asdPreviewEl = document.createElement("div");
    asdPreviewEl.className = "asd-prompt-preview";
    document.body.appendChild(asdPreviewEl);

    asdPreviewEl.addEventListener("mouseenter", () => clearTimeout(asdPreviewTimer));
    asdPreviewEl.addEventListener("mouseleave", asdHidePreview);
    // La rueda no debe llegar al lienzo de ComfyUI, que la interpreta como zoom.
    // The wheel must not reach ComfyUI's canvas, which reads it as zoom.
    asdPreviewEl.addEventListener("wheel", (e) => e.stopPropagation());

    return asdPreviewEl;
}

function asdShowPreview(text, anchorEl) {
    const el = asdPreviewPanel();
    clearTimeout(asdPreviewTimer);

    // textContent, no innerHTML: el prompt puede traer <video 1> o similares y
    // aqui no hay que escapar nada ni arriesgarse a inyectar marcado.
    // textContent, not innerHTML: a prompt may carry <video 1> and the like, so
    // nothing needs escaping and no markup can be injected.
    el.textContent = text;
    el.style.display = "block";
    el.scrollTop = 0;

    const r = anchorEl.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;

    // A la izquierda de la tarjeta si cabe, que es donde no tapa la bandeja;
    // si no cabe, a la derecha. Siempre dentro de la ventana.
    // Left of the card when it fits, where it does not cover the tray; right
    // otherwise. Always clamped inside the viewport.
    let x = r.left - w - 10;
    if (x < 8) x = Math.min(r.right + 10, window.innerWidth - w - 8);
    if (x < 8) x = 8;

    let y = r.top - 4;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    if (y < 8) y = 8;

    el.style.left = x + "px";
    el.style.top = y + "px";
}

function asdHidePreview() {
    // Margen para poder cruzar el hueco entre la tarjeta y el panel sin que se
    // cierre por el camino.
    // Grace period so the gap between card and panel can be crossed without it
    // closing on the way.
    clearTimeout(asdPreviewTimer);
    asdPreviewTimer = setTimeout(() => {
        if (asdPreviewEl) asdPreviewEl.style.display = "none";
    }, 140);
}


/* ── MENU FLOTANTE (mover un prompt a otro grupo) ─────────────────────────────
   En document.body por lo mismo que la vista previa: la bandeja lo recortaria.
   Se cierra al elegir, o al pulsar fuera. / Lives on document.body for the same
   reason as the preview; closes on pick or on a click outside. */
let asdMenuEl = null;
let asdMenuOutside = null;

function asdCloseMenu() {
    if (asdMenuOutside) window.removeEventListener("mousedown", asdMenuOutside, true);
    asdMenuOutside = null;
    if (asdMenuEl) asdMenuEl.remove();
    asdMenuEl = null;
}

function asdOpenMenu(anchorEl, title, items) {
    asdCloseMenu();
    asdEnsureStyles();

    const m = document.createElement("div");
    m.className = "asd-prompt-menu";
    const head = document.createElement("div");
    head.className = "asd-prompt-menu-title";
    head.textContent = title;
    m.appendChild(head);

    if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "asd-prompt-menu-empty";
        empty.textContent = "No other groups";
        m.appendChild(empty);
    }
    for (const it of items) {
        const row = document.createElement("div");
        row.className = "asd-prompt-menu-item";
        row.textContent = it.label;
        row.addEventListener("click", () => { asdCloseMenu(); it.onPick(); });
        m.appendChild(row);
    }
    m.addEventListener("wheel", (e) => e.stopPropagation());
    document.body.appendChild(m);

    const r = anchorEl.getBoundingClientRect();
    const w = m.offsetWidth, h = m.offsetHeight;
    let x = Math.min(r.right - w, window.innerWidth - w - 8);
    if (x < 8) x = 8;
    let y = r.bottom + 2;
    if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 2);
    m.style.left = x + "px";
    m.style.top = y + "px";

    asdMenuEl = m;
    asdMenuOutside = (e) => { if (!m.contains(e.target)) asdCloseMenu(); };
    window.addEventListener("mousedown", asdMenuOutside, true);
}


// Función auxiliar para ocultar el widget nativo de forma limpia y definitiva
function hideNativeTextWidget(node) {
    if (!node.widgets) return;
    const textWidget = node.widgets.find(w => w.name === "text");
    // Salida barata: esta funcion se llama en cada frame desde onDrawForeground.
    if (!textWidget || textWidget.hidden === true) return;

    // El frontend moderno (>= 1.16) decide la visibilidad de un widget por la
    // propiedad `hidden`, NO por `type`. Marcando solo type = "hidden" el widget
    // seguia entrando en el layout y ComfyUI seguia creando su wrapper
    // <div class="dom-widget"> flotando sobre el canvas, que captura los clics.
    textWidget.hidden = true;
    textWidget.type = "hidden"; // compatibilidad con frontends antiguos

    // NUNCA devolver una altura negativa aqui: LiteGraph hace
    // computedHeight = computeSize()[1] + 4, y ComfyUI escribe
    // style.height = (computedHeight - 2 * margin) + "px". Un valor negativo es
    // CSS invalido, el navegador lo descarta y el wrapper cae a height: 100%.
    textWidget.computeSize = () => [0, 0];

    // `element` es la propiedad actual; `inputEl` es un alias deprecado que
    // escupe warnings en consola, asi que solo se usa como ultimo recurso.
    const el = textWidget.element || textWidget.inputEl;
    if (el && el.style) {
        el.style.display = "none";
        el.style.visibility = "hidden";
    }
}


/* ── ALMACEN DE GRUPOS ────────────────────────────────────────────────────────
   Cada grupo es un fichero prompt_lists/<grupo>.json con {favorites, recents},
   el mismo formato de siempre, asi que las listas guardadas siguen valiendo.
   Toda modificacion relee el grupo del disco antes de escribirlo: dos nodos (o
   dos pestañas) con el mismo grupo abierto ya no se pisan los cambios.

   Each group is prompt_lists/<group>.json with {favorites, recents}, the same
   format as before. Every change re-reads the group from disk before writing,
   so two nodes with the same group open no longer clobber each other. */
const MAX_RECENTS = 10;
const q = encodeURIComponent;

const normalizeGroup = (d) => ({
    favorites: Array.isArray(d?.favorites) ? d.favorites : [],
    recents: Array.isArray(d?.recents) ? d.recents : [],
});

async function asdListGroups() {
    const r = await (await fetch("/academia/prompts/list")).json();
    if (r.status !== "success") throw new Error(r.message);
    return r.files;
}

async function asdLoadGroup(name) {
    const r = await (await fetch(`/academia/prompts/load?name=${q(name)}`)).json();
    if (r.status !== "success") throw new Error(r.message);
    return normalizeGroup(r.data);
}

async function asdStoreGroup(name, data) {
    const r = await (await fetch("/academia/prompts/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, data }),
    })).json();
    if (r.status !== "success") throw new Error(r.message);
    return r.name || name;
}

async function asdDeleteGroup(name) {
    const r = await (await fetch(`/academia/prompts/delete?name=${q(name)}`, { method: "DELETE" })).json();
    if (r.status !== "success") throw new Error(r.message);
}

const removeValue = (arr, v) => {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
};

const isDefaultGroup = (name) => name === "default_positive_prompt" || name === "default_negative_prompt";


function registerPromptNode(nodeName, defaultFileName) {
    app.registerExtension({
        name: `AcademiaSD.Prompt.${nodeName}`,
        async beforeRegisterNodeDef(nodeType, nodeData, app) {
            if (nodeData.name !== nodeName) return;

            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                if (onSerialize) onSerialize.apply(this, arguments);
                o.asd_expanded = this.expandedState;
                o.asd_current_list = this.currentList;
                o.asd_tray_height = this.trayHeight;
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(o) {
                if (onConfigure) onConfigure.apply(this, arguments);
                if (o.asd_expanded !== undefined) this.expandedState = o.asd_expanded;
                if (o.asd_current_list !== undefined) this.currentList = o.asd_current_list;
                if (o.asd_tray_height !== undefined) this.trayHeight = o.asd_tray_height;

                hideNativeTextWidget(this);
                if (this.updatePanelState) this.updatePanelState();
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);
                asdEnsureStyles();

                // El nodo mide lo mismo con el panel abierto o cerrado: al abrirlo,
                // el panel le quita sitio a la caja de texto. El minimo es el que
                // necesita el panel abierto para que quepa entero.
                // The node keeps its size with the panel open or closed: opening it
                // takes room from the text box. The minimum fits the open panel.
                const MIN_WIDTH = 420;
                const MIN_HEIGHT = 230;
                this.size = [MIN_WIDTH, 300];
                const _this = this;

                this.expandedState = this.expandedState !== undefined ? this.expandedState : false;
                this.currentList = this.currentList || defaultFileName;
                this.trayHeight = this.trayHeight || 80;
                this.activeTab = "favorites";
                this.filterText = "";
                this.groups = [];
                this.promptListData = normalizeGroup(null);

                hideNativeTextWidget(this);

                const container = document.createElement("div");
                container.className = "asd-p-root";
                container.innerHTML = `
                    <textarea class="asd-p-textarea" placeholder="Enter your prompt here..."></textarea>
                    <div class="asd-p-row">
                        <button class="asd-p-btn asd-toggle-panel" style="flex: 1; overflow: hidden; text-overflow: ellipsis;"></button>
                        <button class="asd-p-btn asd-p-red asd-add-favorite">❤️ Favorite</button>
                    </div>
                    <div class="asd-p-extended">
                        <div class="asd-p-row">
                            <span class="asd-p-label">Group</span>
                            <select class="asd-p-input asd-group-select" style="flex: 1; min-width: 0; padding: 1px;"></select>
                            <button class="asd-p-btn asd-group-new" title="New empty group">➕</button>
                            <button class="asd-p-btn asd-group-rename" title="Rename this group">✏️</button>
                            <button class="asd-p-btn asd-p-red asd-group-delete" title="Delete this group">🗑️</button>
                            <button class="asd-p-btn asd-group-import" title="Import a group from a .json file">📥</button>
                            <button class="asd-p-btn asd-group-export" title="Export this group as a .json file">📤</button>
                            <input type="file" class="asd-file-import" accept=".json" style="display: none;">
                        </div>
                        <div class="asd-p-row">
                            <button class="asd-p-btn asd-p-tab asd-tab-favorites">⭐ Favorites</button>
                            <button class="asd-p-btn asd-p-tab asd-tab-recents">⏪ Recents</button>
                            <input class="asd-p-input asd-filter" placeholder="🔍 Filter..." style="flex: 1; min-width: 0;">
                        </div>
                        <div class="asd-p-splitter" title="Drag to resize the list"></div>
                        <div class="asd-p-tray"></div>
                    </div>
                `;

                const $ = (sel) => container.querySelector(sel);
                const textarea = $(".asd-p-textarea");
                const toggleBtn = $(".asd-toggle-panel");
                const addFavBtn = $(".asd-add-favorite");
                const extendedArea = $(".asd-p-extended");
                const groupSelect = $(".asd-group-select");
                const renameBtn = $(".asd-group-rename");
                const deleteBtn = $(".asd-group-delete");
                const tabRecents = $(".asd-tab-recents");
                const tabFavorites = $(".asd-tab-favorites");
                const filterInput = $(".asd-filter");
                const promptsTray = $(".asd-p-tray");
                const splitter = $(".asd-p-splitter");
                const fileImport = $(".asd-file-import");

                // Las teclas escritas aqui no son atajos del lienzo.
                for (const el of [textarea, filterInput]) {
                    el.addEventListener("keydown", (e) => e.stopPropagation());
                    el.addEventListener("keyup", (e) => e.stopPropagation());
                }

                const flash = (btn, text, original) => {
                    btn.innerText = text;
                    setTimeout(() => btn.innerText = original, 1200);
                };

                const setTray = (h) => {
                    _this.trayHeight = h;
                    promptsTray.style.flexBasis = h + "px";
                };

                // Arrastrar hacia arriba agranda la lista y achica la caja de texto.
                // Dragging up grows the list and shrinks the text box.
                {
                    let startY = 0, startH = 0;
                    const onMouseMove = (e) => {
                        const max = Math.max(30, container.clientHeight - 140);
                        setTray(Math.max(30, Math.min(max, startH + startY - e.clientY)));
                    };
                    const onMouseUp = () => {
                        splitter.classList.remove("dragging");
                        window.removeEventListener("mousemove", onMouseMove);
                        window.removeEventListener("mouseup", onMouseUp);
                    };
                    splitter.addEventListener("mousedown", (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        startY = e.clientY;
                        startH = promptsTray.offsetHeight;
                        splitter.classList.add("dragging");
                        window.addEventListener("mousemove", onMouseMove);
                        window.addEventListener("mouseup", onMouseUp);
                    });
                }

                // El wrapper .dom-widget que crea ComfyUI ya tiene exactamente el
                // tamaño del hueco reservado dentro del nodo. El container solo debe
                // rellenarlo al 100%: fijar pixeles aqui lo desincronizaba del wrapper
                // y ademas escribia estilos en cada frame (layout thrash).
                const adjustContainerHeight = () => {
                    if (container.style.height !== "100%") {
                        container.style.height = "100%";
                        container.style.maxHeight = "100%";
                    }
                };

                this.computeSize = function() {
                    return [MIN_WIDTH, MIN_HEIGHT];
                };

                const originalOnResize = this.onResize;
                this.onResize = function(size) {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    if (size[0] < MIN_WIDTH) size[0] = MIN_WIDTH;
                    if (size[1] < MIN_HEIGHT) size[1] = MIN_HEIGHT;
                    adjustContainerHeight();
                    app.graph?.setDirtyCanvas(true, true);
                };

                // Con `prompt` conectado manda el nodo de arriba y lo que haya
                // en esta caja no se usa. Sin avisarlo, uno escribe aqui, no ve
                // ningun cambio en la generacion y no hay nada que se lo
                // explique -- asi que la caja se atenua y lo dice en su hueco.
                // El texto NO se borra: sigue ahi para cuando se desconecte.
                //
                // With `prompt` wired the upstream node decides and whatever is
                // in this box goes unused. Unannounced, you type here, see no
                // change in the output, and nothing explains why. The text is
                // not cleared: it waits for the link to go away.
                // NO basta con mirar si hay cable: un cable que sale de un nodo
                // en bypass o silenciado no trae nada, asi que la caja vuelve a
                // mandar y tiene que poder editarse. Un enlace presente no es
                // lo mismo que un enlace VIVO.
                //
                // A wire is not enough: one coming out of a bypassed or muted
                // node carries nothing, so the box is back in charge and has to
                // be editable. A link being there is not the same as it being
                // LIVE.
                const NUNCA = 2, BYPASS = 4;
                const marcadorPropio = textarea.placeholder;

                const estadoEntrada = () => {
                    const ent = _this.inputs || [];
                    let idx = -1;
                    for (let i = 0; i < ent.length; i++) {
                        if (ent[i] && ent[i].name === "prompt") { idx = i; break; }
                    }
                    if (idx < 0 || ent[idx].link == null) return "libre";

                    let n;
                    try { n = _this.getInputNode(idx); } catch (e) { return "libre"; }
                    // Un Reroute es un cable con forma de nodo: se atraviesa. En
                    // bypass se comporta igual que normal, asi que solo corta si
                    // esta silenciado. / A Reroute is a cable shaped like a node.
                    let salto = 0;
                    while (n && /reroute/i.test(n.type || "") && salto++ < 8) {
                        if (n.mode === NUNCA) return "apagado";
                        try { n = n.getInputNode(0); } catch (e) { return "libre"; }
                    }
                    if (!n) return "libre";
                    return (n.mode === NUNCA || n.mode === BYPASS) ? "apagado" : "vivo";
                };

                const refrescarEntrada = () => {
                    const est = estadoEntrada();
                    if (est === _this._promptEstado) return;   // salida barata
                    _this._promptEstado = est;
                    const fantasma = est === "vivo";
                    textarea.readOnly = fantasma;
                    textarea.style.opacity = fantasma ? "0.4" : "1";
                    textarea.style.borderStyle = fantasma ? "dashed" : "solid";
                    textarea.title = fantasma
                        ? "driven by the connected prompt input; this text is unused"
                        : (est === "apagado"
                            ? "the connected node is bypassed, so this text is used"
                            : "");
                    textarea.placeholder = fantasma
                        ? "⇠ driven by the connected prompt"
                        : marcadorPropio;
                };

                const originalDrawForeground = this.onDrawForeground;
                this.onDrawForeground = function(ctx) {
                    hideNativeTextWidget(_this);
                    refrescarEntrada();
                    adjustContainerHeight();
                    if (originalDrawForeground) originalDrawForeground.apply(this, arguments);
                };

                // Lo que usan otros nodos para escribir aqui el prompt: la caja y
                // el widget que se ejecuta, siempre a la vez.
                this.asdSetText = (text) => {
                    textarea.value = text;
                    const liveTextWidget = _this.widgets.find(w => w.name === "text");
                    if (liveTextWidget) liveTextWidget.value = text;
                };

                // Inserta en el cursor (o al final, si nunca se ha tocado la caja)
                // con un espacio a cada lado si hace falta. Lo usa Multi Image
                // Reference para escribir <image1> y compañia.
                // Inserts at the caret, adding a space on either side if needed.
                this.asdInsertText = (text) => {
                    const v = textarea.value;
                    const a = textarea.selectionStart ?? v.length;
                    const b = textarea.selectionEnd ?? a;
                    const before = v.slice(0, a), after = v.slice(b);
                    const head = before + (before && !/\s$/.test(before) ? " " : "") + text;
                    _this.asdSetText(head + (after && !/^\s/.test(after) ? " " : "") + after);
                    textarea.setSelectionRange(head.length, head.length);
                };

                textarea.addEventListener("input", (e) => {
                    const liveTextWidget = _this.widgets.find(w => w.name === "text");
                    if (liveTextWidget) liveTextWidget.value = e.target.value;
                });

                const updatePanelState = () => {
                    extendedArea.style.display = _this.expandedState ? "flex" : "none";
                    toggleBtn.innerText = `${_this.expandedState ? "▲" : "▼"} 📁 ${_this.currentList}`;
                    toggleBtn.title = _this.expandedState ? "Hide the prompt groups" : "Show the prompt groups";
                    addFavBtn.title = `Save the prompt as a favorite in "${_this.currentList}"`;
                    setTray(_this.trayHeight || 80);
                    adjustContainerHeight();
                    app.graph?.setDirtyCanvas(true, true);
                };
                this.updatePanelState = updatePanelState;

                // Al abrir el panel, y antes de mover, se relee la lista de grupos:
                // otro nodo puede haber creado o borrado alguno mientras tanto.
                // The group list is re-read on opening and before a move: another
                // node may have created or deleted one in the meantime.
                toggleBtn.addEventListener("click", () => {
                    _this.expandedState = !_this.expandedState;
                    updatePanelState();
                    if (_this.expandedState) refreshGroups().catch(e => console.error("[AcademiaSD Prompt]", e));
                });

                // --- GRUPOS ---
                const renderGroups = () => {
                    groupSelect.innerHTML = "";
                    for (const g of _this.groups) {
                        const opt = document.createElement("option");
                        opt.value = g;
                        opt.textContent = g;
                        groupSelect.appendChild(opt);
                    }
                    groupSelect.value = _this.currentList;
                    const fijo = isDefaultGroup(_this.currentList);
                    renameBtn.disabled = fijo;
                    deleteBtn.disabled = fijo;
                };

                const refreshGroups = async () => {
                    _this.groups = await asdListGroups();
                    if (!_this.groups.includes(_this.currentList)) _this.currentList = defaultFileName;
                    renderGroups();
                };

                const selectGroup = async (name) => {
                    _this.promptListData = await asdLoadGroup(name);
                    _this.currentList = name;
                    renderGroups();
                    renderTray();
                    updatePanelState();
                };

                // Relee el grupo, lo cambia y lo guarda. Si es el que se esta
                // viendo, la bandeja se repinta con lo que quedo en disco.
                // Re-reads the group, changes it and stores it.
                const mutate = async (name, fn) => {
                    const data = await asdLoadGroup(name);
                    fn(data);
                    await asdStoreGroup(name, data);
                    if (name === _this.currentList) {
                        _this.promptListData = data;
                        renderTray();
                    }
                };

                const askNewName = (message, suggestion) => {
                    const name = (prompt(message, suggestion) || "").trim();
                    if (!name) return null;
                    if (_this.groups.includes(name)) {
                        alert(`A group named "${name}" already exists.`);
                        return null;
                    }
                    return name;
                };

                groupSelect.addEventListener("change", () => {
                    selectGroup(groupSelect.value).catch(e => console.error("[AcademiaSD Prompt]", e));
                });

                $(".asd-group-new").addEventListener("click", async () => {
                    const name = askNewName("Name of the new group:", "");
                    if (!name) return;
                    const saved = await asdStoreGroup(name, normalizeGroup(null));
                    await refreshGroups();
                    await selectGroup(saved);
                });

                renameBtn.addEventListener("click", async () => {
                    const old = _this.currentList;
                    if (isDefaultGroup(old)) return;
                    const name = askNewName(`New name for "${old}":`, old);
                    if (!name) return;
                    const saved = await asdStoreGroup(name, await asdLoadGroup(old));
                    if (saved !== old) await asdDeleteGroup(old);
                    await refreshGroups();
                    await selectGroup(saved);
                });

                deleteBtn.addEventListener("click", async () => {
                    const name = _this.currentList;
                    if (isDefaultGroup(name)) return;
                    const n = _this.promptListData.favorites.length;
                    if (!confirm(`Delete the group "${name}" and its ${n} favorite prompt(s)? This cannot be undone.`)) return;
                    await asdDeleteGroup(name);
                    await refreshGroups();
                    await selectGroup(defaultFileName);
                });

                $(".asd-group-export").addEventListener("click", () => {
                    const blob = new Blob([JSON.stringify(_this.promptListData, null, 4)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${_this.currentList}.json`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                });

                // Importar a un grupo que ya existe SUMA sus prompts, no lo
                // sustituye: asi un import nunca borra nada.
                // Importing into an existing group merges, never replaces.
                $(".asd-group-import").addEventListener("click", () => fileImport.click());
                fileImport.addEventListener("change", (e) => {
                    const file = e.target.files[0];
                    fileImport.value = "";
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async (event) => {
                        let parsed;
                        try { parsed = JSON.parse(event.target.result); } catch (err) {
                            alert("Error parsing JSON file.");
                            return;
                        }
                        if (!Array.isArray(parsed?.favorites) && !Array.isArray(parsed?.recents)) {
                            alert("Invalid file structure. It must contain 'favorites' or 'recents'.");
                            return;
                        }
                        const incoming = normalizeGroup(parsed);
                        const name = file.name.replace(/\.json$/i, "");
                        if (_this.groups.includes(name)) {
                            if (!confirm(`The group "${name}" already exists. Add the imported prompts to it?`)) return;
                            await mutate(name, (d) => {
                                for (const p of incoming.favorites) if (!d.favorites.includes(p)) d.favorites.push(p);
                            });
                            await selectGroup(name);
                            return;
                        }
                        const saved = await asdStoreGroup(name, incoming);
                        await refreshGroups();
                        await selectGroup(saved);
                    };
                    reader.readAsText(file);
                });

                // --- PESTAÑAS Y FILTRO ---
                tabFavorites.addEventListener("click", () => { _this.activeTab = "favorites"; renderTray(); });
                tabRecents.addEventListener("click", () => { _this.activeTab = "recents"; renderTray(); });
                filterInput.addEventListener("input", () => { _this.filterText = filterInput.value; renderTray(); });

                // --- BOTÓN FAVORITOS ---
                addFavBtn.addEventListener("click", async () => {
                    const activePrompt = textarea.value.trim();
                    if (!activePrompt) return flash(addFavBtn, "⚠️ Write prompt!", "❤️ Favorite");
                    if (_this.promptListData.favorites.includes(activePrompt)) {
                        return flash(addFavBtn, "⭐ Already Fav!", "❤️ Favorite");
                    }
                    await mutate(_this.currentList, (d) => {
                        if (!d.favorites.includes(activePrompt)) d.favorites.unshift(activePrompt);
                    });
                    _this.activeTab = "favorites";
                    renderTray();
                    flash(addFavBtn, "✅ Saved!", "❤️ Favorite");
                });

                // --- BANDEJA ---
                const cardButton = (label, title, extraClass) => {
                    const b = document.createElement("button");
                    b.className = "asd-p-btn" + (extraClass ? " " + extraClass : "");
                    b.textContent = label;
                    b.title = title;
                    return b;
                };

                const renderTray = () => {
                    const data = _this.promptListData;
                    const tab = _this.activeTab;
                    tabFavorites.classList.toggle("active", tab === "favorites");
                    tabRecents.classList.toggle("active", tab === "recents");
                    tabFavorites.textContent = `⭐ Favorites (${data.favorites.length})`;
                    tabRecents.textContent = `⏪ Recents (${data.recents.length})`;

                    promptsTray.innerHTML = "";
                    const filtro = _this.filterText.trim().toLowerCase();
                    const lista = data[tab].filter(p => !filtro || p.toLowerCase().includes(filtro));

                    if (!lista.length) {
                        const empty = document.createElement("div");
                        empty.className = "asd-p-empty";
                        empty.textContent = filtro ? "No prompt matches the filter"
                            : (tab === "favorites" ? "No favorites in this group yet" : "No recent prompts yet");
                        promptsTray.appendChild(empty);
                        return;
                    }

                    for (const promptText of lista) {
                        const card = document.createElement("div");
                        card.className = "asd-p-card" + (tab === "recents" ? " recent" : "");

                        const txt = document.createElement("div");
                        txt.className = "asd-p-card-text";
                        txt.textContent = promptText.replace(/\s+/g, " ").trim();

                        const btns = document.createElement("div");
                        btns.className = "asd-p-card-btns";
                        const loadBtn = cardButton("📂", "Load this prompt into the box");
                        btns.appendChild(loadBtn);
                        if (tab === "recents") {
                            const favBtn = cardButton("❤️", "Add to this group's favorites");
                            favBtn.addEventListener("click", () => mutate(_this.currentList, (d) => {
                                if (!d.favorites.includes(promptText)) d.favorites.unshift(promptText);
                            }));
                            btns.appendChild(favBtn);
                        }
                        const moveBtn = cardButton("➜", "Move to the favorites of another group");
                        const delBtn = cardButton("🗑️", "Remove from this list", "asd-p-red");
                        btns.appendChild(moveBtn);
                        btns.appendChild(delBtn);

                        card.appendChild(txt);
                        card.appendChild(btns);

                        // Sobre la tarjeta entera: el texto lleva el puntero igual.
                        card.addEventListener("mouseenter", () => asdShowPreview(promptText, card));
                        card.addEventListener("mouseleave", asdHidePreview);

                        loadBtn.addEventListener("click", () => {
                            asdHidePreview();
                            _this.asdSetText(promptText);
                            _this.expandedState = false;
                            updatePanelState();
                        });

                        moveBtn.addEventListener("click", async () => {
                            asdHidePreview();
                            await refreshGroups();
                            const origen = _this.currentList;
                            const destinos = _this.groups.filter(g => g !== origen);
                            asdOpenMenu(moveBtn, "Move to the favorites of:", destinos.map(g => ({
                                label: g,
                                onPick: async () => {
                                    await mutate(g, (d) => {
                                        if (!d.favorites.includes(promptText)) d.favorites.unshift(promptText);
                                    });
                                    await mutate(origen, (d) => removeValue(d[tab], promptText));
                                },
                            })));
                        });

                        delBtn.addEventListener("click", () => {
                            asdHidePreview();
                            mutate(_this.currentList, (d) => removeValue(d[tab], promptText));
                        });

                        promptsTray.appendChild(card);
                    }
                };

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                // IMPORTANTE: NO sobrescribir domWidget.computeSize.
                //
                // LGraphNode._arrangeWidgets() toma la rama `if (w.computeSize)` y hace
                // computedHeight = computeSize()[1] + 4  ->  con [0, 0] eso da 4.
                // Despues DomWidgets.vue calcula el tamaño del wrapper como
                // computedHeight - 2 * margin  ->  4 - 20 = -16, y aplica
                // style.height = "-16px". Es CSS invalido: el navegador lo descarta y
                // manda la clase `size-full` (height: 100%) del propio wrapper. Como el
                // wrapper es position: fixed, ese 100% es el alto del VIEWPORT: queda un
                // rectangulo transparente, con pointer-events: auto, del ancho del nodo y
                // bajando hasta el final de la pantalla. Eso es el "cuadrado invisible"
                // que tapa los nodos de debajo (y por eso empeora al editar el prompt:
                // al enfocar el textarea ComfyUI hace bringToFront y le sube el z-index).
                //
                // Sin computeSize, ComfyUI usa DOMWidgetImpl.computeLayoutSize() y le
                // reparte el espacio libre real del cuerpo del nodo: nunca negativo, y
                // nunca mayor que el nodo (asi que tampoco hay ciclo de crecimiento).
                this.addDOMWidget("UI", "HTML", container, {
                    margin: 4,
                    getMinHeight: () => 60,
                });

                hideNativeTextWidget(this);

                // Cada ejecucion apunta el prompt en los recientes del grupo abierto.
                // Every run records the prompt in the open group's recents.
                const textWidget = this.widgets.find(w => w.name === "text");
                if (textWidget) {
                    textWidget.serializeValue = () => {
                        const currentVal = textarea.value.trim();
                        if (currentVal) {
                            mutate(_this.currentList, (d) => {
                                removeValue(d.recents, currentVal);
                                d.recents.unshift(currentVal);
                                d.recents.length = Math.min(d.recents.length, MAX_RECENTS);
                            }).catch(e => console.error("[AcademiaSD Prompt]", e));
                        }
                        return textarea.value;
                    };
                }

                updatePanelState();

                // El prompt viaja con los proyectos de Multi Image Reference:
                // al guardar se entrega, al cargar se recoge. Ninguno de los
                // dos nodos sabe nada del otro, solo de estos dos eventos.
                const onCollect = (e) => e.detail.add(_this, { text: textarea.value });
                const onApply = (e) => {
                    const data = e.detail.take(_this);
                    if (typeof data?.text === "string") _this.asdSetText(data.text);
                };
                window.addEventListener("academia:project-collect", onCollect);
                window.addEventListener("academia:project-apply", onApply);
                const onRemoved = this.onRemoved;
                this.onRemoved = function () {
                    window.removeEventListener("academia:project-collect", onCollect);
                    window.removeEventListener("academia:project-apply", onApply);
                    asdCloseMenu();
                    if (onRemoved) onRemoved.apply(this, arguments);
                };

                // onConfigure ya ha puesto el grupo guardado cuando esto resuelve.
                refreshGroups()
                    .then(() => selectGroup(_this.currentList))
                    .then(() => {
                        const liveTextWidget = _this.widgets.find(w => w.name === "text");
                        if (liveTextWidget && liveTextWidget.value) textarea.value = liveTextWidget.value;
                    })
                    .catch(e => console.error("[AcademiaSD Prompt] Error loading the prompt groups:", e));
            };
        }
    });
}

registerPromptNode("AcademiaSD_PositivePrompt", "default_positive_prompt");
registerPromptNode("AcademiaSD_NegativePrompt", "default_negative_prompt");
