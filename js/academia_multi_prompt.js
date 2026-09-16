import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MIN_WIDTH = 480;
// Las tres secciones que espera MiniMax-H3. La plantilla anterior era la de
// LTX y no encajaba con nada de lo que hay aqui.
// The three sections MiniMax-H3 expects. The previous template was the LTX one.
const DEFAULT_TEXT = "integrated_multimodal_description:\n\n"
    + "overall_soundscape:\n\n"
    + "non_diegetic_music:\nN/A";

// El widget DOM no ocupa todo lo que se le asigna. El frontend hace
//     let t = n.margin;            // margin = 10
//     r.pos  = [x + t, y + t + n.y];
//     r.size = [..., computedHeight - t * 2];
// o sea que lo baja 10 px y le recorta 20 de alto. Sin devolver esos 20, el
// contenido se sale por debajo del borde del nodo.
//
// The DOM widget does not get all the height it is assigned: the frontend
// offsets it by `margin` and takes 2 * margin off its size.
const MARGEN_DOM = 10;

// Oculta un widget nativo sin dejar su wrapper flotando sobre el canvas.
//
// El frontend moderno decide la visibilidad por la propiedad `hidden`, NO por
// `type`. Y la altura NUNCA puede ser negativa: un valor negativo es CSS
// invalido, el navegador lo descarta y el wrapper cae a height: 100%, o sea un
// rectangulo invisible a pantalla completa que se come todos los clics.
//
// Hides a native widget without leaving its wrapper over the canvas. Visibility
// is decided by `hidden`, not `type`, and the height can NEVER be negative:
// that is invalid CSS and the wrapper falls back to a full-screen rectangle.
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

async function pedirJSON(url, cuerpo) {
    const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
    });
    return await r.json();
}

const CSS = `
.asd-pm-wrap { display: flex; flex-direction: column; gap: 8px; }
.asd-pm-box { background: #1f1f1f; border: 1px solid #3a3a3a; border-radius: 8px;
    padding: 9px 10px; display: flex; flex-direction: column; gap: 7px; }
.asd-pm-head { display: flex; justify-content: space-between; align-items: center;
    color: #cfcfcf; font-size: 11px; font-weight: 700; letter-spacing: .3px;
    text-transform: uppercase; }
.asd-pm-note { color: #7b7b7b; font-size: 10px; font-weight: 400; text-transform: none;
    letter-spacing: 0; }
.asd-pm-ta { width: 100%; padding: 9px 10px; box-sizing: border-box; border: 1px solid #454545;
    border-radius: 6px; background: #121212; color: #e8e8e8; outline: none; resize: vertical;
    font-family: Consolas, "SF Mono", monospace; font-size: 12.5px; line-height: 1.5; }
.asd-pm-ta:focus { border-color: #4a8fe0; box-shadow: 0 0 0 2px rgba(74,143,224,.15); }
.asd-pm-ta::placeholder { color: #555; }

.asd-pm-btnrow { display: flex; gap: 7px; }
.asd-pm-btn { flex: 1; cursor: pointer; padding: 8px; color: #fff; border: none;
    border-radius: 6px; font-weight: 700; font-size: 11.5px; transition: background .15s; }
.asd-pm-save { background: #2f7d43; } .asd-pm-save:hover { background: #389751; }
.asd-pm-load { background: #4c5563; } .asd-pm-load:hover { background: #626c7d; }

/* --- tira de fotogramas --- */
.asd-pm-strip { display: flex; gap: 7px; overflow-x: auto; overflow-y: hidden;
    padding: 2px 2px 8px 2px; scroll-behavior: smooth; }
.asd-pm-strip::-webkit-scrollbar { height: 7px; }
.asd-pm-strip::-webkit-scrollbar-track { background: #191919; border-radius: 4px; }
.asd-pm-strip::-webkit-scrollbar-thumb { background: #454545; border-radius: 4px; }
.asd-pm-strip::-webkit-scrollbar-thumb:hover { background: #5a5a5a; }

.asd-pm-card { flex: 0 0 auto; width: 108px; cursor: pointer; border-radius: 7px;
    border: 2px solid transparent; background: #171717; overflow: hidden;
    transition: border-color .15s, transform .12s; }
.asd-pm-card:hover { border-color: #55606e; transform: translateY(-1px); }
.asd-pm-card.sel { border-color: #4a8fe0; }
.asd-pm-thumb { width: 100%; height: 61px; display: block; object-fit: cover;
    background: #0e0e0e; }
.asd-pm-vacio { width: 100%; height: 61px; display: flex; align-items: center;
    justify-content: center; background: #131313;
    border-bottom: 1px dashed #3a3a3a; color: #4d4d4d; font-size: 15px; }
.asd-pm-pie { display: flex; align-items: center; justify-content: space-between;
    padding: 4px 6px; font-size: 10.5px; color: #9a9a9a; font-family: Consolas, monospace; }
.asd-pm-card.sel .asd-pm-pie { color: #cfe3ff; background: #22303f; }
.asd-pm-aviso { color: #6f6f6f; font-size: 9px; }

.asd-pm-add { flex: 0 0 auto; width: 44px; border-radius: 7px; border: 2px dashed #3f3f3f;
    background: #171717; color: #7b7b7b; cursor: pointer; font-size: 19px;
    display: flex; align-items: center; justify-content: center; transition: .15s; }
.asd-pm-add:hover { border-color: #4a8fe0; color: #4a8fe0; background: #1b2531; }

/* --- editor --- */
.asd-pm-edhead { display: flex; align-items: baseline; gap: 9px; }
.asd-pm-loop { color: #eaeaea; font-size: 13px; font-weight: 700; }
.asd-pm-desde { color: #7b7b7b; font-size: 10.5px; font-family: Consolas, monospace; }
.asd-pm-del { background: transparent; border: 1px solid #4a3030;
    color: #9a6a6a; cursor: pointer; font-size: 10.5px; border-radius: 5px; padding: 3px 9px;
    transition: .15s; }
.asd-pm-del:hover { background: #3a2222; color: #e07a7a; border-color: #7a3a3a; }
.asd-pm-del:disabled { opacity: .3; cursor: default; }
.asd-pm-primero { margin-left: auto; margin-right: 6px; }
.asd-pm-cuenta { text-align: right; color: #666; font-size: 10px;
    font-family: Consolas, monospace; margin-top: -3px; }
.asd-pm-zoom { color: #8a8a8a; font-size: 10px; font-family: Consolas, monospace;
    min-width: 30px; display: inline-block; text-align: center; }
.asd-pm-mini:disabled { opacity: .3; cursor: default; }
.asd-pm-mini:disabled:hover { color: #7b7b7b; }
.asd-pm-mini { background: transparent; border: none; color: #7b7b7b; cursor: pointer;
    font-size: 11px; padding: 0 3px; }
.asd-pm-mini:hover { color: #4a8fe0; }
`;

app.registerExtension({
    name: "AcademiaSD.MultiPrompt",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "AcademiaSD_MultiPrompt") return;

        // Las medidas que el usuario ajusta a mano -- el alto de las dos cajas de
        // texto y el zoom de la tira -- viajan con el nodo en `asd_ui`. No son
        // adorno: quien estira el editor o agranda las miniaturas lo hace porque
        // a ese tamaño ve lo que necesita, y perderlo en cada recarga obliga a
        // rehacerlo siempre. Van fuera de `widgets_values` a proposito, que es
        // posicional y lo comparte el Python.
        //
        // The hand-set measurements -- both textarea heights and the strip zoom --
        // travel with the node in `asd_ui`. Losing them on every reload means
        // redoing them every time. Kept out of `widgets_values`, which is
        // positional and shared with the Python side.
        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            if (onSerialize) onSerialize.apply(this, arguments);
            if (this.volcarEstado) this.volcarEstado();
            o.asd_ui = {
                zoom: this.tiraZoom,
                globalH: this.altoGlobal,
                loopH: this.altoLoop,
                sel: this.loopSel,
            };
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (o) {
            if (onConfigure) onConfigure.apply(this, arguments);
            const w = this.widgets ? this.widgets.find((x) => x.name === "prompt_data") : null;
            if (w && w.value) {
                try {
                    this.promptState = JSON.parse(w.value);
                } catch (e) {}
            }
            const u = o && o.asd_ui;
            if (u) {
                if (typeof u.zoom === "number") this.tiraZoom = u.zoom;
                if (u.globalH) this.altoGlobal = u.globalH;
                if (u.loopH) this.altoLoop = u.loopH;
                if (typeof u.sel === "number") this.loopSel = u.sel;
            }
            if (this.aplicarMedidas) this.aplicarMedidas();
            if (this.renderUI) this.renderUI();
        };

        // El Multi-Prompt se ejecuta al principio de cada vuelta, asi que al
        // terminar ya existe el fotograma de la vuelta anterior: es el momento
        // exacto en el que la tira tiene algo nuevo que enseñar.
        // Multi-Prompt runs at the start of every pass, so by the time it
        // finishes the previous take's frame exists: exactly when the strip has
        // something new to show.
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function () {
            if (onExecuted) onExecuted.apply(this, arguments);
            if (this.cargarFrames) this.cargarFrames();
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            const _this = this;
            if (!this.promptState) this.promptState = [{ text: DEFAULT_TEXT }];
            if (this.loopSel == null) this.loopSel = 0;
            this.frames = {};

            const dataWidget = ocultarWidget(this, "prompt_data");
            // `project_name` se queda VISIBLE: un widget nativo trae su zocalo de
            // entrada y puede recibir el enlace de Project Paths. Escondido
            // detras de una caja del DOM no habria donde conectar.
            const projWidget = this.widgets
                ? this.widgets.find((w) => w.name === "project_name")
                : null;
            const globalWidget = ocultarWidget(this, "global_prompt");

            this.size = [MIN_WIDTH, 420];

            // DOS capas. `container` es lo que recibe addDOMWidget y lo que el
            // frontend redimensiona en cada redibujado desde el tamaño del nodo;
            // medir SU altura para decidir la del nodo es circular y el nodo
            // crece solo al hacer zoom. `inner` es mio, a altura automatica.
            //
            // TWO layers: measuring the element the frontend itself sizes is
            // circular and makes the node grow on every zoom. `inner` is mine.
            const container = document.createElement("div");
            container.style.cssText = "width:100%;box-sizing:border-box;overflow:visible;";
            const inner = document.createElement("div");
            inner.className = "asd-pm-wrap";
            inner.style.cssText += ";width:100%;box-sizing:border-box;margin-top:8px;"
                + "padding-bottom:6px;font-family:'Segoe UI',system-ui,sans-serif;";
            container.appendChild(inner);

            let domW = null;

            const style = document.createElement("style");
            style.innerHTML = CSS;
            inner.appendChild(style);

            // ---------- proyecto ----------
            const cajaProy = document.createElement("div");
            cajaProy.className = "asd-pm-box";
            const cabProy = document.createElement("div");
            cabProy.className = "asd-pm-head";
            const titProy = document.createElement("span");
            titProy.innerText = "📁 Project";
            const notaProy = document.createElement("span");
            notaProy.className = "asd-pm-note";
            cabProy.append(titProy, notaProy);
            const filaBtn = document.createElement("div");
            filaBtn.className = "asd-pm-btnrow";
            const btnSave = document.createElement("button");
            btnSave.className = "asd-pm-btn asd-pm-save";
            btnSave.innerText = "💾 Save Project";
            const btnLoad = document.createElement("button");
            btnLoad.className = "asd-pm-btn asd-pm-load";
            btnLoad.innerText = "📂 Load Project";
            filaBtn.append(btnSave, btnLoad);
            cajaProy.append(cabProy, filaBtn);
            inner.appendChild(cajaProy);

            // ---------- prompt global ----------
            const cajaGlobal = document.createElement("div");
            cajaGlobal.className = "asd-pm-box";
            const cabGlobal = document.createElement("div");
            cabGlobal.className = "asd-pm-head";
            const tg = document.createElement("span");
            tg.innerText = "🌐 Global Prompt";
            const ng = document.createElement("span");
            ng.className = "asd-pm-note";
            ng.innerText = "goes in front of every loop";
            cabGlobal.append(tg, ng);
            const areaGlobal = document.createElement("textarea");
            areaGlobal.className = "asd-pm-ta";
            areaGlobal.style.minHeight = "56px";
            areaGlobal.style.height = "56px";
            areaGlobal.placeholder = "subject_definitions:\n...";
            areaGlobal.value = globalWidget ? globalWidget.value || "" : "";
            cajaGlobal.append(cabGlobal, areaGlobal);
            inner.appendChild(cajaGlobal);

            // ---------- tira ----------
            const cajaTira = document.createElement("div");
            cajaTira.className = "asd-pm-box";
            const cabTira = document.createElement("div");
            cabTira.className = "asd-pm-head";
            const tt = document.createElement("span");
            // "Prompt loops" y no "loops" a secas: en Moviola un loop es una vuelta
            // YA generada, con sus ficheros en disco, y los botones de borrar de
            // ese nodo se llevan justo eso. Aqui solo hay texto.
            // Not plain "loops": in Moviola a loop is a take already generated,
            // with files on disk, and that node's delete buttons remove exactly
            // those. Here there is only text.
            tt.innerText = "🎞 Prompt Loops";
            const derTira = document.createElement("span");
            derTira.className = "asd-pm-note";
            const btnMenos = document.createElement("button");
            btnMenos.className = "asd-pm-mini";
            btnMenos.innerText = "−";
            btnMenos.title = "smaller thumbnails";
            const etqZoom = document.createElement("span");
            etqZoom.className = "asd-pm-zoom";
            const btnMas = document.createElement("button");
            btnMas.className = "asd-pm-mini";
            btnMas.innerText = "+";
            btnMas.title = "bigger thumbnails";
            const btnRecargar = document.createElement("button");
            btnRecargar.className = "asd-pm-mini";
            btnRecargar.innerText = "⟳";
            btnRecargar.title = "reload the frames from disk";
            derTira.append(btnMenos, etqZoom, btnMas, btnRecargar);
            cabTira.append(tt, derTira);
            const tira = document.createElement("div");
            tira.className = "asd-pm-strip";
            cajaTira.append(cabTira, tira);
            inner.appendChild(cajaTira);

            // ---------- editor ----------
            const cajaEd = document.createElement("div");
            cajaEd.className = "asd-pm-box";
            const cabEd = document.createElement("div");
            cabEd.className = "asd-pm-edhead";
            const etqLoop = document.createElement("span");
            etqLoop.className = "asd-pm-loop";
            const etqDesde = document.createElement("span");
            etqDesde.className = "asd-pm-desde";
            // Los dos borrados juntos y con la misma pinta, porque son la misma
            // clase de accion sobre la misma cosa: uno quita el prompt de delante
            // y el otro todos. Antes el de "todos" era un icono de 11 px perdido
            // entre el zoom y el refresh -- ni se veia, ni estaba donde se busca.
            //
            // Both deletions together and alike: same kind of action on the same
            // thing. The "all" one used to be an 11px icon lost between the zoom
            // and the reload -- invisible, and nowhere near where you look for it.
            const btnVaciar = document.createElement("button");
            btnVaciar.className = "asd-pm-del asd-pm-primero";
            btnVaciar.innerText = "Delete All Prompts";
            btnVaciar.title = "removes every prompt loop; nothing on disk";

            const btnDel = document.createElement("button");
            btnDel.className = "asd-pm-del";
            // "Selected Prompt" y no "loop": el nodo Moviola tiene al lado un
            // "Delete Last Loop" que borra ficheros generados. Esto solo quita
            // el texto de la tarjeta seleccionada, y confundirlos sale caro.
            // Not "loop": the Moviola node has a "Delete Last Loop" next door
            // that removes generated files. This only drops the selected card's
            // text, and mixing them up is expensive.
            btnDel.innerText = "Delete Selected Prompt";
            btnDel.title = "removes this prompt only, nothing on disk";
            cabEd.append(etqLoop, etqDesde, btnVaciar, btnDel);
            const areaLoop = document.createElement("textarea");
            areaLoop.className = "asd-pm-ta";
            areaLoop.style.minHeight = "150px";
            areaLoop.style.height = "170px";
            const cuenta = document.createElement("div");
            cuenta.className = "asd-pm-cuenta";
            cajaEd.append(cabEd, areaLoop, cuenta);
            inner.appendChild(cajaEd);

            // ---------- tamaño ----------
            this.computeSize = function () {
                const h = (inner.scrollHeight || 380) + 2 * MARGEN_DOM + 6;
                // El ancho que se DEVUELVE es el actual, no el minimo. computeSize
                // dice "cuanto necesito", y devolver siempre MIN_WIDTH afirma que
                // no necesito mas: cualquiera que use ese valor para dimensionar
                // -- incluido el widget DOM -- deja el contenido clavado en el
                // minimo por ancho que se ponga el nodo. El minimo sigue siendo un
                // suelo, no una talla unica.
                //
                // The width RETURNED is the current one, not the minimum.
                // computeSize states "how much I need", and always answering
                // MIN_WIDTH claims I never need more: anything sizing from it --
                // the DOM widget included -- pins the content to the minimum
                // however wide the node gets. The minimum stays a floor, not a
                // fixed size.
                const ancho = Math.max(
                    (this.size && this.size[0]) || MIN_WIDTH, MIN_WIDTH);
                if (domW && typeof domW.last_y === "number" && domW.last_y > 0) {
                    return [ancho, domW.last_y + h];
                }
                const nIn = this.inputs ? this.inputs.length : 0;
                const nOut = this.outputs ? this.outputs.length : 0;
                return [ancho, 60 + Math.max(nIn, nOut) * 22 + h];
            };

            // El ancho del contenido se fija a mano desde el tamano del nodo, con
            // la MISMA cuenta que usa el frontend para enmarcar un widget DOM
            // (`node.size[0] - 2 * margin`, con margin = 10). No es duplicar su
            // trabajo por gusto: el frontend la aplica sobre una copia del tamano
            // del nodo que no siempre esta al dia, y cuando se queda atras el
            // contenido se encoge hasta el minimo mientras el cuerpo del nodo
            // sigue dibujandose ancho -- que es justo lo que pasaba al cargar un
            // proyecto. Calcularlo aqui, donde el tamano de verdad esta siempre a
            // mano, deja de depender de cuando se refresque esa copia.
            //
            // The content width is set by hand from the node size, with the SAME
            // arithmetic the frontend uses to frame a DOM widget
            // (`node.size[0] - 2 * margin`, margin = 10). Not duplication for its
            // own sake: the frontend applies it to a cached copy of the node size
            // that is not always current, and when that copy lags the content
            // shrinks to the minimum while the node body still draws wide -- which
            // is exactly what loading a project did. Doing it here, where the real
            // size is always at hand, stops depending on when that copy refreshes.
            const fijarAncho = (w) => {
                const util = Math.round(Math.max(w || 0, MIN_WIDTH) - 2 * MARGEN_DOM);
                if (container.style.width !== util + "px") {
                    container.style.width = util + "px";
                }
            };

            const originalOnResize = this.onResize;
            this.onResize = function (size) {
                if (originalOnResize) originalOnResize.apply(this, arguments);
                const m = this.computeSize();
                if (size[1] < m[1]) size[1] = m[1];
                // Aqui MIN_WIDTH, no m[0]: m[0] ya es el ancho actual, asi que
                // compararlo consigo mismo impediria estrechar el nodo nunca.
                // MIN_WIDTH here, not m[0]: m[0] is already the current width, so
                // comparing it with itself would make the node impossible to
                // narrow again.
                if (size[0] < MIN_WIDTH) size[0] = MIN_WIDTH;
                fijarAncho(size[0]);
            };

            const ajustar = () => {
                if (_this._ajustando) return;
                _this._ajustando = true;
                requestAnimationFrame(() => {
                    try {
                        const ancho = Math.max(_this.size[0], MIN_WIDTH);
                        // Primero el ancho y luego el alto: `scrollHeight` depende
                        // de lo ancho que sea el contenido, asi que medirlo antes
                        // de recolocarlo devuelve el alto de la anchura anterior.
                        // Width first, height second: `scrollHeight` depends on how
                        // wide the content is, so measuring before re-laying it out
                        // returns the height of the previous width.
                        fijarAncho(ancho);
                        const alto = _this.computeSize()[1];
                        if (Math.abs(_this.size[1] - alto) > 1 || _this.size[0] !== ancho) {
                            _this.setSize([ancho, alto]);
                            app.graph.setDirtyCanvas(true, true);
                        }
                    } finally {
                        _this._ajustando = false;
                    }
                });
            };
            if (typeof ResizeObserver !== "undefined") {
                this._ro = new ResizeObserver(() => ajustar());
                this._ro.observe(inner);
            }

            // ---------- medidas que el usuario fija a mano ----------
            //
            // Se apuntan al SOLTAR el tirador, no en cada `input`: durante el
            // arrastre el alto cambia decenas de veces por segundo y no hace
            // falta guardar ninguno de los pasos intermedios.
            // Recorded on mouse-up, not on every event: during the drag the height
            // changes dozens of times a second and no intermediate step matters.
            this.aplicarMedidas = () => {
                if (_this.altoGlobal) areaGlobal.style.height = _this.altoGlobal;
                if (_this.altoLoop) areaLoop.style.height = _this.altoLoop;
            };
            const recordarAlto = (el, campo) => {
                el.addEventListener("mouseup", () => {
                    const h = el.style.height;
                    if (h && h !== _this[campo]) {
                        _this[campo] = h;
                        app.graph.setDirtyCanvas(true, false);
                    }
                });
            };
            recordarAlto(areaGlobal, "altoGlobal");
            recordarAlto(areaLoop, "altoLoop");

            // ---------- estado ----------
            this.volcarEstado = () => {
                if (dataWidget) dataWidget.value = JSON.stringify(_this.promptState);
                if (globalWidget) globalWidget.value = areaGlobal.value;
            };
            const guardar = () => {
                _this.volcarEstado();
                app.graph.setDirtyCanvas(true, false);
            };
            areaGlobal.addEventListener("input", guardar);

            // ---------- de que proyecto se trata ----------
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
            const nodoArriba = () => {
                const i = ranuraProyecto();
                if (i < 0 || !_this.inputs[i] || _this.inputs[i].link == null) return null;
                try {
                    return _this.getInputNode(i);
                } catch (e) {
                    return null;
                }
            };
            const nombreDeArriba = () => {
                const n = nodoArriba();
                const w = n && n.widgets ? n.widgets.find((x) => x.name === "project_name") : null;
                return w && w.value ? String(w.value) : null;
            };
            const nombreProyecto = () =>
                String(nombreDeArriba() || (projWidget && projWidget.value) || "").trim();

            const refrescarEnlace = () => {
                const a = nombreDeArriba();
                titProy.innerText = a !== null ? "📁 Project  ⇠ " + a : "📁 Project";
            };
            this.refrescarEnlace = refrescarEnlace;

            // ---------- fotogramas ----------
            //
            // La ruta no se guarda: Project Paths la CALCULA y no la deja en
            // ningun widget, asi que el navegador no puede leerla. Se le pide al
            // servidor, que aplica la regla de verdad. Una sola copia de la regla.
            //
            // The path is never cached: Project Paths computes it and stores it
            // in no widget. The server is asked instead -- one copy of the rule.
            const resolverPath = async () => {
                const nom = nombreProyecto();
                if (!nom) return "";
                try {
                    const r = await pedirJSON("/academia/projectpaths/resolve",
                                              { project_name: nom });
                    if (r.status === "success" && r.path) return r.path;
                } catch (e) {}
                return "";
            };

            this.cargarFrames = async () => {
                const path = await resolverPath();
                if (!path) {
                    _this.frames = {};
                    _this.renderTira();
                    return;
                }
                try {
                    const r = await pedirJSON("/academia/moviola/frames", { path });
                    const m = {};
                    if (r.status === "success") {
                        for (const f of r.frames || []) m[f.n] = f;
                    }
                    _this.frames = m;
                } catch (e) {
                    _this.frames = {};
                }
                _this.renderTira();
            };

            // ---------- pintar ----------
            const clamp = () => {
                const n = _this.promptState.length;
                if (_this.loopSel >= n) _this.loopSel = n - 1;
                if (_this.loopSel < 0) _this.loopSel = 0;
            };

            // El zoom se guarda con el nodo: quien agranda las miniaturas lo hace
            // porque a ese tamaño ve lo que necesita, y perderlo al recargar el
            // workflow obliga a repetirlo cada vez. Igual que las alturas que se
            // arrastran a mano. / The zoom is saved with the node: losing it on
            // reload means redoing it every time.
            const ZOOM_MIN = 0.7, ZOOM_MAX = 2.6, ANCHO_CARTA = 108, ALTO_THUMB = 61;
            if (typeof this.tiraZoom !== "number") this.tiraZoom = 1;

            const aplicarZoom = () => {
                const z = _this.tiraZoom;
                etqZoom.innerText = Math.round(z * 100) + "%";
                btnMenos.disabled = z <= ZOOM_MIN + 0.001;
                btnMas.disabled = z >= ZOOM_MAX - 0.001;
                for (const card of tira.querySelectorAll(".asd-pm-card")) {
                    card.style.width = Math.round(ANCHO_CARTA * z) + "px";
                    const vis = card.querySelector(".asd-pm-thumb, .asd-pm-vacio");
                    if (vis) vis.style.height = Math.round(ALTO_THUMB * z) + "px";
                }
                const mas = tira.querySelector(".asd-pm-add");
                if (mas) mas.style.width = Math.round(44 * z) + "px";
            };

            const cambiarZoom = (paso) => {
                const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, _this.tiraZoom + paso));
                if (z === _this.tiraZoom) return;
                _this.tiraZoom = z;
                aplicarZoom();
                ajustar();
            };
            btnMenos.addEventListener("click", () => cambiarZoom(-0.2));
            btnMas.addEventListener("click", () => cambiarZoom(0.2));

            this.renderTira = () => {
                clamp();
                tira.innerHTML = "";
                _this.promptState.forEach((item, idx) => {
                    // El fotograma que ARRANCA la vuelta N es el ultimo de la N-1.
                    // El de la vuelta 1 es el cero, que solo existe si hubo imagen
                    // base; sin ella la serie empezo solo con el prompt.
                    // Take N starts from take N-1's last frame. Take 1 starts from
                    // zero, which only exists when there was a base image.
                    const f = _this.frames[idx];
                    const card = document.createElement("div");
                    card.className = "asd-pm-card" + (idx === _this.loopSel ? " sel" : "");
                    card.title = f ? f.filename : (idx === 0 ? "starts from the prompt alone"
                                                             : "not generated yet");
                    if (f) {
                        const img = document.createElement("img");
                        img.className = "asd-pm-thumb";
                        img.loading = "lazy";
                        img.src = api.apiURL(`/view?filename=${encodeURIComponent(f.filename)}`
                            + `&subfolder=${encodeURIComponent(f.subfolder)}&type=output`
                            + `&t=${Date.now()}`);
                        card.appendChild(img);
                    } else {
                        const hueco = document.createElement("div");
                        hueco.className = "asd-pm-vacio";
                        hueco.innerText = idx === 0 ? "✎" : "▦";
                        card.appendChild(hueco);
                    }
                    const pie = document.createElement("div");
                    pie.className = "asd-pm-pie";
                    const num = document.createElement("span");
                    num.innerText = idx + 1;
                    const av = document.createElement("span");
                    av.className = "asd-pm-aviso";
                    av.innerText = f ? "" : (idx === 0 ? "t2v" : "—");
                    pie.append(num, av);
                    card.appendChild(pie);
                    card.addEventListener("click", () => {
                        _this.loopSel = idx;
                        _this.renderTira();
                        _this.renderEditor();
                    });
                    tira.appendChild(card);
                });

                const mas = document.createElement("div");
                mas.className = "asd-pm-add";
                mas.innerText = "+";
                // Singular: cada clic añade uno. El plural va en la cabecera de la
                // seccion, que sí nombra al conjunto.
                // Singular: one per click. The plural belongs in the section
                // header, which does name the whole set.
                mas.title = "add prompt loop";
                mas.addEventListener("click", () => {
                    const ult = _this.promptState.length
                        ? _this.promptState[_this.promptState.length - 1].text.trim()
                        : "";
                    _this.promptState.push({ text: ult || DEFAULT_TEXT });
                    _this.loopSel = _this.promptState.length - 1;
                    guardar();
                    _this.renderTira();
                    _this.renderEditor();
                    tira.scrollLeft = tira.scrollWidth;
                });
                tira.appendChild(mas);
                aplicarZoom();

                const sel = tira.children[_this.loopSel];
                if (sel && sel.scrollIntoView) {
                    sel.scrollIntoView({ block: "nearest", inline: "nearest" });
                }
            };

            this.renderEditor = () => {
                clamp();
                const i = _this.loopSel;
                const item = _this.promptState[i];
                etqLoop.innerText = `🎬 Prompt Loop ${i + 1}`;
                const f = _this.frames[i];
                etqDesde.innerText = f ? `starts from ${f.filename}`
                    : (i === 0 ? "starts from the prompt alone" : "previous take not generated yet");
                btnDel.disabled = _this.promptState.length <= 1;
                if (document.activeElement !== areaLoop) areaLoop.value = item ? item.text : "";
                cuenta.innerText = `${(item ? item.text : "").length} chars`;
            };

            areaLoop.addEventListener("input", function () {
                const item = _this.promptState[_this.loopSel];
                if (!item) return;
                item.text = this.value;
                cuenta.innerText = `${this.value.length} chars`;
                guardar();
            });

            btnDel.addEventListener("click", () => {
                if (_this.promptState.length <= 1) return;
                _this.promptState.splice(_this.loopSel, 1);
                guardar();
                _this.renderTira();
                _this.renderEditor();
            });

            btnRecargar.addEventListener("click", () => _this.cargarFrames());

            // Vaciar los prompts NO toca el disco: los fotogramas, las latentes y
            // los videos siguen donde estaban. Solo se va el texto, que es lo unico
            // que vive en el nodo -- para lo otro estan los botones de Moviola.
            //
            // Clearing the prompts does NOT touch disk: frames, latents and videos
            // stay where they were. Only the text goes, which is all that lives in
            // this node -- the Moviola buttons are for the rest.
            btnVaciar.addEventListener("click", () => {
                const n = _this.promptState.length;
                const hayGlobal = !!areaGlobal.value.trim();
                if (n <= 1 && !(_this.promptState[0] || {}).text && !hayGlobal) return;
                if (!confirm(`Delete all ${n} prompt loop${n === 1 ? "" : "s"}`
                    + `${hayGlobal ? " and the global prompt" : ""}?\n\n`
                    + "Only the text written here. Frames, latents and videos on disk "
                    + "are untouched.\nThis cannot be undone.")) return;
                // El global se va con ellos: es la cabecera de ESTA serie, asi que
                // dejarlo en pie al vaciar los loops significa empezar la siguiente
                // con el sujeto y el aspecto de la anterior sin haberlo pedido.
                //
                // The global goes too: it is THIS series' header, so leaving it
                // standing means starting the next one with the previous subject
                // and look without having asked for them.
                _this.promptState = [{ text: DEFAULT_TEXT }];
                _this.loopSel = 0;
                areaGlobal.value = "";
                guardar();
                _this.renderTira();
                _this.renderEditor();
            });

            this.renderUI = () => {
                if (_this.widgets) {
                    const g = _this.widgets.find((w) => w.name === "global_prompt");
                    if (g && document.activeElement !== areaGlobal) {
                        areaGlobal.value = g.value || "";
                    }
                }
                refrescarEnlace();
                _this.renderTira();
                _this.renderEditor();
                ajustar();
            };

            // ---------- guardar / cargar proyecto ----------
            btnSave.addEventListener("click", async () => {
                const nombre = nombreProyecto();
                if (!nombre) {
                    notaProy.innerText = "⚠ name it first";
                    return;
                }
                _this.volcarEstado();
                try {
                    // Guardar con un nombre que ya existe PISA el guion entero de
                    // una serie, asi que se pregunta antes.
                    const lista = await (await fetch("/academia/multiprompt/list")).json();
                    if (lista.status === "success" && (lista.files || []).includes(nombre)) {
                        if (!confirm(`Project "${nombre}" already exists.\n\n`
                            + `Overwrite it with the current ${_this.promptState.length} prompts?`)) {
                            notaProy.innerText = "";
                            return;
                        }
                    }
                    const r = await pedirJSON("/academia/multiprompt/save", {
                        name: nombre,
                        global_prompt: areaGlobal.value,
                        prompts: _this.promptState,
                    });
                    notaProy.innerText = r.status === "success"
                        ? `✔ saved (${r.count})` : `⚠ ${r.message || "could not save"}`;
                } catch (e) {
                    notaProy.innerText = "⚠ no answer from the server";
                }
                setTimeout(() => (notaProy.innerText = ""), 4000);
            });

            const cargarProyecto = async (nombre) => {
                try {
                    const r = await (await fetch("/academia/multiprompt/load?name="
                        + encodeURIComponent(nombre))).json();
                    if (r.status !== "success") {
                        notaProy.innerText = `⚠ ${r.message || "could not read it"}`;
                        return;
                    }
                    const d = r.data || {};
                    const lista = Array.isArray(d.prompts) ? d.prompts : [];
                    _this.promptState = lista.length ? lista : [{ text: DEFAULT_TEXT }];
                    _this.loopSel = 0;
                    areaGlobal.value = d.global_prompt || "";

                    // Cargar un proyecto cambia el PROYECTO, no solo los prompts.
                    // Con el nombre enlazado, el de verdad vive en Project Paths y
                    // de ahi salen las carpetas de salida y la ruta del montador:
                    // escribirlo aqui abajo dejaria los prompts de un proyecto
                    // apuntando a las carpetas de otro.
                    //
                    // Loading switches the PROJECT, not just the prompts.
                    const arriba = nodoArriba();
                    const wArriba = arriba && arriba.widgets
                        ? arriba.widgets.find((x) => x.name === "project_name") : null;
                    if (wArriba) {
                        wArriba.value = nombre;
                        if (typeof wArriba.callback === "function") wArriba.callback(nombre);
                        app.graph.setDirtyCanvas(true, true);
                    } else if (projWidget) {
                        projWidget.value = nombre;
                    }

                    guardar();
                    _this.renderUI();
                    await _this.cargarFrames();
                    notaProy.innerText = `✔ ${_this.promptState.length} prompts`;
                    setTimeout(() => (notaProy.innerText = ""), 4000);
                } catch (e) {
                    notaProy.innerText = "⚠ no answer from the server";
                }
            };

            // El menu cuelga de document.body: dentro del contenedor lo recortaria
            // el overflow del wrapper del widget DOM.
            let menu = null;
            const cerrarMenu = () => {
                if (menu) {
                    menu.remove();
                    menu = null;
                    document.removeEventListener("mousedown", fuera, true);
                }
            };
            const fuera = (e) => {
                if (menu && !menu.contains(e.target) && e.target !== btnLoad) cerrarMenu();
            };

            btnLoad.addEventListener("click", async () => {
                if (menu) return cerrarMenu();
                let files = [];
                try {
                    const r = await (await fetch("/academia/multiprompt/list")).json();
                    if (r.status === "success") files = r.files || [];
                } catch (e) {}
                menu = document.createElement("div");
                menu.style.cssText = "position:fixed;z-index:10000;background:#1b1b1b;"
                    + "border:1px solid #4a4a4a;border-radius:8px;padding:5px;max-height:280px;"
                    + "overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.65);min-width:190px;"
                    + "font-family:'Segoe UI',system-ui,sans-serif;";
                if (!files.length) {
                    const v = document.createElement("div");
                    v.style.cssText = "padding:8px 11px;color:#777;font-size:12px;";
                    v.innerText = "no saved projects";
                    menu.appendChild(v);
                } else {
                    files.forEach((f) => {
                        const fila = document.createElement("div");
                        fila.style.cssText = "padding:8px 11px;color:#ddd;font-size:12px;"
                            + "cursor:pointer;border-radius:5px;";
                        fila.innerText = "📂 " + f;
                        fila.onmouseover = () => (fila.style.background = "#33415e");
                        fila.onmouseout = () => (fila.style.background = "transparent");
                        fila.addEventListener("click", () => {
                            cerrarMenu();
                            cargarProyecto(f);
                        });
                        menu.appendChild(fila);
                    });
                }
                menu.addEventListener("wheel", (e) => e.stopPropagation());
                const r = btnLoad.getBoundingClientRect();
                menu.style.left = r.left + "px";
                menu.style.top = r.bottom + 4 + "px";
                menu.style.minWidth = r.width + "px";
                document.body.appendChild(menu);
                document.addEventListener("mousedown", fuera, true);
            });

            // ---------- eventos del lienzo ----------
            container.addEventListener("mousedown", (e) => e.stopPropagation());
            container.addEventListener("wheel", (e) => {
                const t = e.target;
                if (t && t.tagName === "TEXTAREA") {
                    e.stopPropagation();
                    return;
                }
                // Sobre la tira, la rueda vertical desplaza en HORIZONTAL: es lo
                // que espera cualquiera delante de una fila de miniaturas, y sin
                // esto el gesto se lo queda el zoom del grafo.
                // Over the strip the vertical wheel scrolls HORIZONTALLY, which is
                // what anyone expects facing a row of thumbnails.
                if (t && (t === tira || tira.contains(t))) {
                    e.stopPropagation();
                    e.preventDefault();
                    tira.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
                }
            }, { passive: false });

            domW = this.addDOMWidget("UI", "HTML", container);

            // El fotograma nuevo lo escribe Moviola Out al FINAL de la vuelta,
            // pero este nodo se ejecuta al principio: refrescar en su `onExecuted`
            // deja la tira siempre una vuelta por detras. `execution_success` lo
            // emite el backend cuando termina la ejecucion entera
            // (execution.py:824), que es cuando el fichero ya existe.
            //
            // The new frame is written by Moviola Out at the END of the pass while
            // this node runs at the start, so refreshing on its own `onExecuted`
            // leaves the strip one pass behind. `execution_success` is emitted by
            // the backend when the whole run finishes, which is when the file is
            // actually there.
            const alTerminar = () => {
                if (_this.cargarFrames) _this.cargarFrames();
            };
            api.addEventListener("execution_success", alTerminar);

            const onRemoved = this.onRemoved;
            this.onRemoved = function () {
                cerrarMenu();
                if (_this._ro) _this._ro.disconnect();
                // Sin quitarlo, cada nodo borrado deja un oyente vivo pidiendo
                // fotogramas de un proyecto que ya no se esta mirando.
                // Left behind, every deleted node keeps a listener asking for
                // frames of a project nobody is looking at.
                api.removeEventListener("execution_success", alTerminar);
                if (onRemoved) onRemoved.apply(this, arguments);
            };

            // Cambiar el NOMBRE aguas arriba no cambia ninguna conexion, asi que
            // `onConnectionsChange` no se entera. Se mira en el redibujado: leer
            // un widget no cuesta nada y solo se repinta cuando cambio de verdad.
            const onDraw = this.onDrawForeground;
            this.onDrawForeground = function () {
                if (onDraw) onDraw.apply(this, arguments);
                if (this.flags && this.flags.collapsed) return;
                const ahora = String(nombreDeArriba() || "");
                if (ahora !== this._ultimoArriba) {
                    this._ultimoArriba = ahora;
                    refrescarEnlace();
                    if (this._vistoUnaVez) this.cargarFrames();
                    this._vistoUnaVez = true;
                }
            };

            const onConnectionsChange = this.onConnectionsChange;
            this.onConnectionsChange = function () {
                if (onConnectionsChange) onConnectionsChange.apply(this, arguments);
                refrescarEnlace();
            };

            setTimeout(() => {
                if (dataWidget && dataWidget.value && dataWidget.value !== "[]") {
                    try {
                        _this.promptState = JSON.parse(dataWidget.value);
                    } catch (e) {}
                }
                _this.aplicarMedidas();
                _this.renderUI();
                _this.cargarFrames();
            }, 120);
        };
    },
});
