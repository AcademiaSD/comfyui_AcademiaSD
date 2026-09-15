import { app } from "../../scripts/app.js";

const MIN_WIDTH = 440;
const DEFAULT_TEXT = "[VISUAL]:\n[SPEECH]:\n[SOUNDS]:";

// Oculta un widget nativo sin dejar su wrapper flotando sobre el canvas.
//
// El frontend moderno decide la visibilidad por la propiedad `hidden`, NO por
// `type`. Y la altura NUNCA puede ser negativa: LiteGraph calcula
// computedHeight = computeSize()[1] + 4 y ComfyUI escribe
// style.height = (computedHeight - 2 * margin) + "px". Un valor negativo es CSS
// invalido, el navegador lo descarta y el wrapper cae a height: 100%, o sea un
// rectangulo invisible a pantalla completa que se come todos los clics.
//
// Hides a native widget without leaving its wrapper floating over the canvas.
// Visibility is decided by `hidden`, not by `type`, and the height can NEVER be
// negative: that is invalid CSS, the browser drops it and the wrapper falls back
// to height: 100% -- a full-screen invisible rectangle that eats every click.
function ocultarWidget(node, nombre) {
    const w = node.widgets ? node.widgets.find((x) => x.name === nombre) : null;
    if (!w) return null;
    w.hidden = true;
    w.type = "hidden";
    w.computeSize = () => [0, 0];
    w.draw = function () {};
    const el = w.element || w.inputEl;
    if (el && el.style) {
        el.style.display = "none";
        el.style.visibility = "hidden";
    }
    return w;
}

async function pedirJSON(url, opciones) {
    const r = await fetch(url, opciones);
    return await r.json();
}

app.registerExtension({
    name: "AcademiaSD.MultiPrompt",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "AcademiaSD_MultiPrompt") return;

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            if (onSerialize) onSerialize.apply(this, arguments);
            if (this.volcarEstado) this.volcarEstado();
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (o) {
            if (onConfigure) onConfigure.apply(this, arguments);
            const dataWidget = this.widgets ? this.widgets.find((w) => w.name === "prompt_data") : null;
            if (dataWidget && dataWidget.value) {
                try {
                    this.promptState = JSON.parse(dataWidget.value);
                } catch (e) {}
            }
            if (this.renderUI) this.renderUI();
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            const _this = this;

            if (!this.promptState) {
                this.promptState = [{ text: DEFAULT_TEXT }];
            }

            const dataWidget = ocultarWidget(this, "prompt_data");
            // `project_name` se queda VISIBLE a proposito. Un widget nativo trae
            // su zocalo de entrada y puede recibir el enlace de Project Paths;
            // escondiendolo detras de una caja mia del DOM no habria donde
            // conectar, y el nombre habria que escribirlo dos veces.
            // Left VISIBLE on purpose: a native widget carries its own input
            // socket and can take the link from Project Paths. Hidden behind a
            // DOM box of mine there would be nothing to connect to.
            const projWidget = this.widgets
                ? this.widgets.find((w) => w.name === "project_name")
                : null;
            const globalWidget = ocultarWidget(this, "global_prompt");

            this.size = [MIN_WIDTH, 320];

            // DOS capas, y la separacion importa.
            //
            // `container` es el elemento que recibe addDOMWidget, y el frontend le
            // escribe en cada redibujado `width`/`height` en pixeles a partir del
            // tamaño del nodo (con transformOrigin 0 0 y transform: scale(zoom)).
            // Medir su scrollHeight para decidir el alto del nodo es circular: ese
            // valor nunca baja de la altura que le acaban de imponer, asi que cada
            // medida sale mas alta que la anterior y el nodo crece solo.
            //
            // `inner` es mio, va a altura automatica y nadie de fuera lo toca: su
            // scrollHeight es contenido puro y no depende ni del zoom ni del
            // tamaño del nodo. Es lo unico que se mide.
            //
            // TWO layers, and the split matters. `container` is what addDOMWidget
            // gets, and the frontend writes width/height on it every redraw from
            // the node's size. Measuring ITS scrollHeight to decide the node's
            // height is circular -- the value never drops below the height just
            // imposed on it, so every measurement comes out taller than the last
            // and the node grows on its own. `inner` is mine, auto-height, touched
            // by nobody: its scrollHeight is pure content.
            const container = document.createElement("div");
            container.style.cssText = "width: 100%; box-sizing: border-box; overflow: visible;";

            const inner = document.createElement("div");
            inner.style.cssText = `
                width: 100%; display: flex; flex-direction: column; gap: 4px;
                font-family: sans-serif; box-sizing: border-box; margin-top: 10px;
                padding-bottom: 6px;
            `;
            container.appendChild(inner);

            // Se declara aqui porque computeSize lo consulta y se asigna mas
            // abajo, al anadir el widget. / Declared here because computeSize
            // reads it and it is assigned further down.
            // El widget DOM no ocupa todo lo que se le asigna. El frontend hace
            //     let t = n.margin;            // margin = 10
            //     r.pos  = [x + t, y + t + n.y];
            //     r.size = [..., computedHeight - t * 2];
            // o sea que lo baja 10 px y le recorta 20 de alto. Sin devolver esos
            // 20, el contenido se sale por debajo del borde del nodo.
            //
            // The DOM widget does not get all the height it is assigned: the
            // frontend offsets it by `margin` and takes 2 * margin off its size.
            // Without giving those 20 px back the content spills past the node.
            const MARGEN_DOM = 10;
            let domW = null;

            const style = document.createElement("style");
            style.innerHTML = `
                .asd-pm-box { background: #222; border: 1px solid #444; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 6px;}
                .asd-pm-header { display: flex; justify-content: space-between; align-items: center; color: #ccc; font-size: 12px; font-weight: bold;}
                .asd-pm-textarea { width: 100%; min-height: 80px; padding: 8px; box-sizing: border-box; border: 1px solid #555; border-radius: 4px; background: #111; color: white; outline: none; resize: vertical; font-family: monospace; font-size: 13px;}
                .asd-pm-textarea:focus { border-color: #4a6ee0; }
                .asd-del-btn { background: transparent; border: none; color: #888; cursor: pointer; transition: 0.2s; font-size: 12px;}
                .asd-del-btn:hover { color: #ff4444; }
                .asd-pm-input { width: 100%; padding: 7px 8px; box-sizing: border-box; border: 1px solid #555; border-radius: 4px; background: #111; color: white; outline: none; font-family: sans-serif; font-size: 13px;}
                .asd-pm-input:focus { border-color: #4a6ee0; }
                .asd-pm-btnrow { display: flex; gap: 6px; }
                .asd-pm-btn { flex: 1; cursor: pointer; padding: 8px; color: white; border: none; border-radius: 4px; font-weight: bold; font-size: 12px; transition: background 0.2s; }
                .asd-pm-save { background: #2f7d43; } .asd-pm-save:hover { background: #389751; }
                .asd-pm-load { background: #555d6b; } .asd-pm-load:hover { background: #697282; }
                .asd-pm-note { color: #777; font-size: 11px; font-weight: normal; }
                .asd-pm-menu { position: fixed; z-index: 10000; background: #1b1b1b; border: 1px solid #555; border-radius: 6px; padding: 4px; max-height: 260px; overflow-y: auto; box-shadow: 0 6px 18px rgba(0,0,0,0.6); min-width: 180px; }
                .asd-pm-menu div { padding: 7px 10px; color: #ddd; font-size: 12px; cursor: pointer; border-radius: 4px; font-family: sans-serif; }
                .asd-pm-menu div:hover { background: #33415e; }
                .asd-pm-menu .asd-pm-vacio { color: #777; cursor: default; }
                .asd-pm-menu .asd-pm-vacio:hover { background: transparent; }
            `;
            inner.appendChild(style);

            // ---- Proyecto -------------------------------------------------
            const cajaProy = document.createElement("div");
            cajaProy.className = "asd-pm-box";

            const cabProy = document.createElement("div");
            cabProy.className = "asd-pm-header";
            const titProy = document.createElement("span");
            titProy.innerText = "📁 Project";
            cabProy.appendChild(titProy);
            const notaProy = document.createElement("span");
            notaProy.className = "asd-pm-note";
            cabProy.appendChild(notaProy);
            cajaProy.appendChild(cabProy);


            const filaBotones = document.createElement("div");
            filaBotones.className = "asd-pm-btnrow";
            const btnSave = document.createElement("button");
            btnSave.className = "asd-pm-btn asd-pm-save";
            btnSave.innerText = "💾 Save Project";
            const btnLoad = document.createElement("button");
            btnLoad.className = "asd-pm-btn asd-pm-load";
            btnLoad.innerText = "📂 Load Project";
            filaBotones.appendChild(btnSave);
            filaBotones.appendChild(btnLoad);
            cajaProy.appendChild(filaBotones);
            inner.appendChild(cajaProy);

            // ---- Prompt global --------------------------------------------
            const cajaGlobal = document.createElement("div");
            cajaGlobal.className = "asd-pm-box";
            const cabGlobal = document.createElement("div");
            cabGlobal.className = "asd-pm-header";
            const titGlobal = document.createElement("span");
            titGlobal.innerText = "🌐 Global Prompt";
            cabGlobal.appendChild(titGlobal);
            const notaGlobal = document.createElement("span");
            notaGlobal.className = "asd-pm-note";
            notaGlobal.innerText = "va delante de cada loop";
            cabGlobal.appendChild(notaGlobal);
            cajaGlobal.appendChild(cabGlobal);

            const areaGlobal = document.createElement("textarea");
            areaGlobal.className = "asd-pm-textarea";
            areaGlobal.style.minHeight = "60px";
            areaGlobal.placeholder = "subject_definitions:\n...";
            areaGlobal.value = globalWidget ? globalWidget.value || "" : "";
            cajaGlobal.appendChild(areaGlobal);
            inner.appendChild(cajaGlobal);

            // ---- Prompts por loop ------------------------------------------
            this.rowsContainer = document.createElement("div");
            this.rowsContainer.style.display = "flex";
            this.rowsContainer.style.flexDirection = "column";
            this.rowsContainer.style.gap = "8px";
            inner.appendChild(this.rowsContainer);

            const btnAdd = document.createElement("button");
            btnAdd.innerText = "➕ Add Prompt Keyframe";
            btnAdd.style.cssText = "cursor: pointer; padding: 10px; background: #225588; color: white; border: none; border-radius: 4px; font-weight: bold; font-size: 12px; margin-top: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.3); transition: background 0.2s;";
            btnAdd.onmouseover = () => (btnAdd.style.background = "#2b6cb0");
            btnAdd.onmouseout = () => (btnAdd.style.background = "#225588");
            inner.appendChild(btnAdd);

            // ---- Tamaño ----------------------------------------------------
            // El alto es "donde empieza el widget DOM" + "lo que mide su
            // contenido". Lo primero NO se estima: LiteGraph lo escribe en
            // `last_y` al dibujar, con el titulo, los zocalos y los widgets
            // nativos ya descontados. Calcularlo a ojo lo cuenta dos veces y deja
            // un hueco muerto al final del nodo.
            //
            // Height is "where the DOM widget starts" plus "how tall its content
            // is". The first half is NOT estimated: LiteGraph writes it into
            // `last_y` while drawing. Guessing it counts things twice and leaves
            // dead space at the bottom.
            this.computeSize = function () {
                let htmlH = inner.scrollHeight;
                if (!htmlH) {
                    // Antes de que el DOM tenga medidas reales.
                    const N = _this.promptState ? _this.promptState.length : 0;
                    htmlH = 250 + N * 140;
                }
                htmlH += 2 * MARGEN_DOM + 6;   // ver MARGEN_DOM
                if (domW && typeof domW.last_y === "number" && domW.last_y > 0) {
                    return [MIN_WIDTH, domW.last_y + htmlH];
                }
                const nIn = this.inputs ? this.inputs.length : 0;
                const nOut = this.outputs ? this.outputs.length : 0;
                return [MIN_WIDTH, 60 + Math.max(nIn, nOut) * 22 + htmlH];
            };

            const originalOnResize = this.onResize;
            this.onResize = function (size) {
                if (originalOnResize) originalOnResize.apply(this, arguments);
                const minSize = this.computeSize();
                if (size[1] < minSize[1]) size[1] = minSize[1];
                if (size[0] < minSize[0]) size[0] = minSize[0];
            };

            // Un solo punto de ajuste, con guarda de reentrada: el observador de
            // abajo dispara en cuanto cambia la altura del contenido, y cambiar el
            // tamaño del nodo cambia el ancho del contenedor, que puede cambiar la
            // altura otra vez. Sin la guarda y sin el umbral, eso se realimenta.
            //
            // One resize path with a reentry guard: the observer below fires as
            // soon as the content height changes, and resizing the node changes
            // the container width, which can change the height again. Without the
            // guard and the threshold that feeds back on itself.
            const forceResize = () => {
                if (_this._ajustando) return;
                _this._ajustando = true;
                requestAnimationFrame(() => {
                    try {
                        const alto = _this.computeSize()[1];
                        const ancho = Math.max(_this.size[0], MIN_WIDTH);
                        if (Math.abs(_this.size[1] - alto) > 1 || _this.size[0] !== ancho) {
                            _this.setSize([ancho, alto]);
                            app.graph.setDirtyCanvas(true, true);
                        }
                    } finally {
                        _this._ajustando = false;
                    }
                });
            };
            this.ajustarAltura = forceResize;

            // Cubre TODO de una vez: añadir, borrar, abrir, escribir, y el tirador
            // de la esquina de cualquier textarea.
            // Covers everything at once: add, delete, open, type, and the resize
            // handle of any textarea.
            if (typeof ResizeObserver !== "undefined") {
                this._ro = new ResizeObserver(() => forceResize());
                this._ro.observe(inner);
            }

            // ---- Estado ----------------------------------------------------
            this.volcarEstado = () => {
                if (dataWidget) dataWidget.value = JSON.stringify(_this.promptState);
                if (globalWidget) globalWidget.value = areaGlobal.value;
            };

            const updateData = () => {
                _this.volcarEstado();
                app.graph.setDirtyCanvas(true, false);
            };

            areaGlobal.addEventListener("input", updateData);

            // ---- Guardar / cargar proyecto ---------------------------------

            // `project_name` puede venir enlazado desde Project Paths, que es el
            // montaje recomendado: el nombre se escribe una sola vez y de ahi
            // salen tanto las carpetas de salida como el .json del proyecto.
            // Cuando esta enlazado, el valor de verdad es el del nodo de arriba,
            // asi que la caja se bloquea -- dejarla escribible seria ofrecer un
            // campo que no hace nada.
            //
            // `project_name` can be linked from Project Paths, which is the
            // recommended wiring: the name is typed once and drives both the
            // output folders and the project's .json. While it is linked the
            // real value lives upstream, so the box is locked -- leaving it
            // editable would offer a field that does nothing.
            const ranuraProyecto = () => {
                const ent = _this.inputs || [];
                for (let i = 0; i < ent.length; i++) {
                    const e = ent[i];
                    if (e.name === "project_name" || (e.widget && e.widget.name === "project_name")) {
                        return i;
                    }
                }
                return -1;
            };

            const nombreDeArriba = () => {
                const i = ranuraProyecto();
                if (i < 0 || !_this.inputs[i] || _this.inputs[i].link == null) return null;
                try {
                    const origen = _this.getInputNode(i);
                    const w = origen && origen.widgets
                        ? origen.widgets.find((x) => x.name === "project_name")
                        : null;
                    return w && w.value ? String(w.value) : null;
                } catch (e) {
                    return null;
                }
            };

            const refrescarEnlace = () => {
                const arriba = nombreDeArriba();
                titProy.innerText = arriba !== null
                    ? "📁 Project  ⇠ " + arriba
                    : "📁 Project";
            };
            this.refrescarEnlace = refrescarEnlace;

            const onConnectionsChange = this.onConnectionsChange;
            this.onConnectionsChange = function () {
                if (onConnectionsChange) onConnectionsChange.apply(this, arguments);
                refrescarEnlace();
            };

            // Cambiar el NOMBRE aguas arriba no cambia ninguna conexion, asi que
            // `onConnectionsChange` no se entera y la cabecera se queda enseñando
            // el proyecto anterior -- que es peor que no enseñar nada, porque el
            // boton de guardar de al lado escribe en el proyecto nuevo.
            //
            // Se comprueba en el redibujado: leer un widget no cuesta nada y solo
            // se repinta cuando el valor ha cambiado de verdad.
            //
            // Changing the NAME upstream changes no connection, so
            // `onConnectionsChange` never fires and the header keeps showing the
            // previous project -- worse than showing nothing, because the save
            // button next to it writes to the new one. Checked on redraw: reading
            // a widget is free and it only repaints when the value really changed.
            const onDraw = this.onDrawForeground;
            this.onDrawForeground = function (ctx) {
                if (onDraw) onDraw.apply(this, arguments);
                if (this.flags && this.flags.collapsed) return;
                const ahora = String(nombreDeArriba() || "");
                if (ahora !== this._ultimoArriba) {
                    this._ultimoArriba = ahora;
                    refrescarEnlace();
                }
            };

            // El nombre que se usa al guardar: el de arriba si lo hay, y si no el
            // de la caja. / The name used when saving: upstream if there is one.
            const nombreProyecto = () =>
                String(nombreDeArriba() || (projWidget && projWidget.value) || "").trim();

            btnSave.addEventListener("click", async () => {
                const nombre = nombreProyecto();
                if (!nombre) {
                    notaProy.innerText = "⚠ ponle nombre primero";
                    return;
                }
                _this.volcarEstado();
                try {
                    // Guardar con un nombre que ya existe PISA el guion entero de
                    // una serie, asi que se pregunta antes.
                    // Saving over an existing name replaces a whole series' script.
                    const lista = await pedirJSON("/academia/multiprompt/list");
                    if (lista.status === "success" && (lista.files || []).includes(nombre)) {
                        if (!confirm(`El proyecto "${nombre}" ya existe.\n\n¿Sobrescribirlo con los ${_this.promptState.length} prompts actuales?`)) {
                            notaProy.innerText = "";
                            return;
                        }
                    }
                    const r = await pedirJSON("/academia/multiprompt/save", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            name: nombre,
                            global_prompt: areaGlobal.value,
                            prompts: _this.promptState,
                        }),
                    });
                    notaProy.innerText = r.status === "success"
                        ? `✔ guardado (${r.count})`
                        : `⚠ ${r.message || "no se pudo guardar"}`;
                } catch (e) {
                    notaProy.innerText = "⚠ sin respuesta del servidor";
                }
                setTimeout(() => (notaProy.innerText = ""), 4000);
            });

            const cargarProyecto = async (nombre) => {
                try {
                    const r = await pedirJSON(
                        "/academia/multiprompt/load?name=" + encodeURIComponent(nombre));
                    if (r.status !== "success") {
                        notaProy.innerText = `⚠ ${r.message || "no se pudo leer"}`;
                        return;
                    }
                    const d = r.data || {};
                    const lista = Array.isArray(d.prompts) ? d.prompts : [];
                    _this.promptState = lista.length ? lista : [{ text: DEFAULT_TEXT }];
                    // Cargar un proyecto cambia el PROYECTO, no solo los prompts.
                    //
                    // Con `project_name` enlazado, el nombre de verdad vive en
                    // Project Paths, y de ahi salen las carpetas de salida y la
                    // ruta que usa el montador. Escribir aqui abajo dejaria los
                    // prompts de un proyecto apuntando a las carpetas de otro, que
                    // es justo la clase de discrepancia que sacar el nombre a un
                    // solo sitio venia a evitar. Asi que se escribe ARRIBA y el
                    // grafo entero se mueve con el.
                    //
                    // Loading a project switches the PROJECT, not just the
                    // prompts. With `project_name` linked the real name lives in
                    // Project Paths, and the output folders and the editor's path
                    // come from there. Writing it down here would leave one
                    // project's prompts pointing at another's folders.
                    const i = ranuraProyecto();
                    const enlazado = i >= 0 && _this.inputs[i] && _this.inputs[i].link != null;
                    let arriba = null;
                    if (enlazado) {
                        try {
                            arriba = _this.getInputNode(i);
                        } catch (e) {}
                    }
                    const wArriba = arriba && arriba.widgets
                        ? arriba.widgets.find((x) => x.name === "project_name")
                        : null;
                    if (wArriba) {
                        wArriba.value = nombre;
                        if (typeof wArriba.callback === "function") wArriba.callback(nombre);
                        app.graph.setDirtyCanvas(true, true);
                    } else if (projWidget) {
                        projWidget.value = nombre;
                    }
                    areaGlobal.value = d.global_prompt || "";
                    updateData();
                    _this.renderUI();
                    notaProy.innerText = `✔ ${_this.promptState.length} prompts`;
                    setTimeout(() => (notaProy.innerText = ""), 4000);
                } catch (e) {
                    notaProy.innerText = "⚠ sin respuesta del servidor";
                }
            };

            // El menu cuelga de document.body, no del nodo: dentro del contenedor
            // lo recortaria el overflow del wrapper del widget DOM.
            // The menu hangs off document.body: inside the container the DOM
            // widget's own overflow would clip it.
            let menuAbierto = null;
            const cerrarMenu = () => {
                if (menuAbierto) {
                    menuAbierto.remove();
                    menuAbierto = null;
                    document.removeEventListener("mousedown", alClicFuera, true);
                }
            };
            const alClicFuera = (e) => {
                if (menuAbierto && !menuAbierto.contains(e.target) && e.target !== btnLoad) {
                    cerrarMenu();
                }
            };

            btnLoad.addEventListener("click", async () => {
                if (menuAbierto) {
                    cerrarMenu();
                    return;
                }
                let ficheros = [];
                try {
                    const r = await pedirJSON("/academia/multiprompt/list");
                    if (r.status === "success") ficheros = r.files || [];
                } catch (e) {}

                const menu = document.createElement("div");
                menu.className = "asd-pm-menu";
                if (!ficheros.length) {
                    const vacio = document.createElement("div");
                    vacio.className = "asd-pm-vacio";
                    vacio.innerText = "no hay proyectos guardados";
                    menu.appendChild(vacio);
                } else {
                    ficheros.forEach((f) => {
                        const fila = document.createElement("div");
                        fila.innerText = "📂 " + f;
                        fila.addEventListener("click", () => {
                            cerrarMenu();
                            cargarProyecto(f);
                        });
                        menu.appendChild(fila);
                    });
                }
                // El menu cuelga de body, asi que la rueda encima llegaria al
                // canvas y haria zoom en vez de desplazar la lista.
                // The menu hangs off body, so the wheel over it would reach the
                // canvas and zoom instead of scrolling the list.
                menu.addEventListener("wheel", (e) => e.stopPropagation());

                const r = btnLoad.getBoundingClientRect();
                menu.style.left = r.left + "px";
                menu.style.top = r.bottom + 4 + "px";
                menu.style.minWidth = r.width + "px";
                document.body.appendChild(menu);
                menuAbierto = menu;
                document.addEventListener("mousedown", alClicFuera, true);
            });

            const onRemoved = this.onRemoved;
            this.onRemoved = function () {
                cerrarMenu();
                if (_this._ro) _this._ro.disconnect();
                if (onRemoved) onRemoved.apply(this, arguments);
            };

            // ---- Filas ------------------------------------------------------
            this.renderUI = () => {
                _this.rowsContainer.innerHTML = "";

                _this.promptState.forEach((item, idx) => {
                    const box = document.createElement("div");
                    box.className = "asd-pm-box";

                    const header = document.createElement("div");
                    header.className = "asd-pm-header";

                    const title = document.createElement("span");
                    title.innerText = `🎬 Prompt loop ${idx + 1}`;
                    header.appendChild(title);

                    if (idx > 0) {
                        const btnDelete = document.createElement("button");
                        btnDelete.className = "asd-del-btn";
                        btnDelete.innerText = "❌";
                        btnDelete.addEventListener("click", () => {
                            _this.promptState.splice(idx, 1);
                            updateData();
                            _this.renderUI();
                        });
                        header.appendChild(btnDelete);
                    } else {
                        const ghost = document.createElement("div");
                        ghost.style.width = "16px";
                        header.appendChild(ghost);
                    }

                    box.appendChild(header);

                    const textarea = document.createElement("textarea");
                    textarea.className = "asd-pm-textarea";
                    textarea.value = item.text;

                    textarea.addEventListener("input", function () {
                        _this.promptState[idx].text = this.value;
                        updateData();
                    });
                    textarea.addEventListener("mouseup", forceResize);

                    box.appendChild(textarea);
                    _this.rowsContainer.appendChild(box);
                });

                const g = _this.widgets
                    ? _this.widgets.find((w) => w.name === "global_prompt")
                    : null;
                if (g && document.activeElement !== areaGlobal) areaGlobal.value = g.value || "";
                refrescarEnlace();

                forceResize();
            };

            btnAdd.addEventListener("click", () => {
                let newText = DEFAULT_TEXT;
                if (_this.promptState.length > 0) {
                    const lastText = _this.promptState[_this.promptState.length - 1].text.trim();
                    if (lastText !== "") {
                        newText = lastText;
                    }
                }
                _this.promptState.push({ text: newText });
                updateData();
                _this.renderUI();
            });

            container.addEventListener("mousedown", (e) => e.stopPropagation());
            // Sin esto, girar la rueda dentro de un textarea largo hace zoom en el
            // grafo en vez de desplazar el texto.
            // Without this, the wheel inside a long textarea zooms the graph
            // instead of scrolling the text.
            container.addEventListener("wheel", (e) => {
                const t = e.target;
                if (t && (t.tagName === "TEXTAREA" || t.classList.contains("asd-pm-menu"))) {
                    e.stopPropagation();
                }
            });

            domW = this.addDOMWidget("UI", "HTML", container);

            setTimeout(() => {
                if (dataWidget && dataWidget.value && dataWidget.value !== "[]" && dataWidget.value !== "") {
                    try {
                        _this.promptState = JSON.parse(dataWidget.value);
                    } catch (e) {}
                }
                _this.renderUI();
            }, 100);
        };
    },
});
