import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const ANCHO_MIN = 380;

async function pedirJSON(url, cuerpo) {
    const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
    });
    return await r.json();
}

app.registerExtension({
    name: "AcademiaSD.Moviola",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "AcademiaSD_Moviola") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            const _this = this;
            this.size = [ANCHO_MIN, 300];

            // Dos capas. `container` es el que recibe addDOMWidget y el que el
            // frontend redimensiona en cada redibujado a partir del tamaño del
            // nodo; medir SU altura para decidir la del nodo es circular y el
            // nodo crece solo al hacer zoom. `inner` va a altura automatica y no
            // lo toca nadie de fuera: es lo unico que se mide.
            //
            // Two layers. `container` is what addDOMWidget gets and what the
            // frontend resizes from the node's size every redraw; measuring ITS
            // height to decide the node's is circular and the node grows on its
            // own when zooming. `inner` is auto-height and untouched.
            const container = document.createElement("div");
            container.style.cssText = "width: 100%; box-sizing: border-box;";

            const inner = document.createElement("div");
            inner.style.cssText = `
                width: 100%; display: flex; flex-direction: column; gap: 6px;
                font-family: sans-serif; box-sizing: border-box; margin-top: 8px;
                padding-bottom: 6px;
            `;
            container.appendChild(inner);

            const style = document.createElement("style");
            style.innerHTML = `
                .asd-mv-btnrow { display: flex; gap: 6px; }
                .asd-mv-btn { flex: 1; cursor: pointer; padding: 9px 6px; color: #fff; border: none;
                    border-radius: 4px; font-weight: bold; font-size: 12px; transition: background .2s; }
                .asd-mv-btn:disabled { opacity: .5; cursor: default; }
                .asd-mv-edit { background: #225588; } .asd-mv-edit:hover:enabled { background: #2b6cb0; }
                .asd-mv-undo { background: #7a4a25; } .asd-mv-undo:hover:enabled { background: #96591f; }
                .asd-mv-wipe { background: #7a2a2a; } .asd-mv-wipe:hover:enabled { background: #99302f; }
                .asd-mv-refresh { background: #3d5a4a; } .asd-mv-refresh:hover:enabled { background: #4a6e5a; }
                .asd-mv-folder { background: #4a4468; } .asd-mv-folder:hover:enabled { background: #5d5683; }
                .asd-mv-player { display: flex; flex-direction: column; gap: 6px; }
                .asd-mv-tabs { display: flex; gap: 6px; }
                .asd-mv-tab { flex: 1; cursor: pointer; padding: 5px 8px; border-radius: 5px;
                    border: 1px solid #3a3a3a; background: #1c1c1c; color: #9a9a9a;
                    font-size: 10.5px; font-weight: 600; transition: .15s; }
                .asd-mv-tab:hover { border-color: #55606e; color: #ccc; }
                .asd-mv-tab.sel { background: #22303f; border-color: #4a8fe0; color: #cfe3ff; }
                .asd-mv-video { width: 100%; display: block; border-radius: 6px;
                    background: #000; border: 1px solid #333; }
                .asd-mv-console { background: #0d0d0d; border: 1px solid #444; border-radius: 6px;
                    padding: 8px; color: #b8d8b8; font-family: Consolas, monospace; font-size: 11px;
                    line-height: 1.45; white-space: pre-wrap; word-break: break-word;
                    min-height: 96px; max-height: 320px; overflow-y: auto; margin: 0; }
            `;
            inner.appendChild(style);

            const fila = document.createElement("div");
            fila.className = "asd-mv-btnrow";
            const btnEdit = document.createElement("button");
            btnEdit.className = "asd-mv-btn asd-mv-edit";
            btnEdit.innerText = "🎬 Auto Film Edit";
            const btnUndo = document.createElement("button");
            btnUndo.className = "asd-mv-btn asd-mv-undo";
            btnUndo.innerText = "🗑 Delete Last Loop";
            fila.appendChild(btnEdit);
            fila.appendChild(btnUndo);
            inner.appendChild(fila);

            const fila2 = document.createElement("div");
            fila2.className = "asd-mv-btnrow";
            const btnRefresh = document.createElement("button");
            btnRefresh.className = "asd-mv-btn asd-mv-refresh";
            btnRefresh.innerText = "🔄 Refresh";
            const btnWipe = document.createElement("button");
            btnWipe.className = "asd-mv-btn asd-mv-wipe";
            btnWipe.innerText = "🗑 Delete All Loops";
            const btnFolder = document.createElement("button");
            btnFolder.className = "asd-mv-btn asd-mv-folder";
            btnFolder.innerText = "\ud83d\udcc2 Open Folder";
            btnFolder.title = "open the project folder and list what is in it";
            fila2.appendChild(btnRefresh);
            fila2.appendChild(btnFolder);
            fila2.appendChild(btnWipe);
            inner.appendChild(fila2);

            const consola = document.createElement("pre");
            consola.className = "asd-mv-console";
            consola.innerText = "Ready.";
            inner.appendChild(consola);
            this._consola = consola;

            // ---- reproductor ----
            //
            // Aparece solo cuando el montaje existe. Terminar el proceso mandando
            // a buscar el fichero por el explorador es una barrera tonta justo en
            // el ultimo paso, y no todo el mundo se maneja ahi.
            //
            // Shows up only when the cut exists. Ending the process by sending
            // people to hunt for the file in the file manager is a silly barrier
            // at the very last step.
            const cajaVideo = document.createElement("div");
            cajaVideo.className = "asd-mv-player";
            cajaVideo.hidden = true;
            const pestanas = document.createElement("div");
            pestanas.className = "asd-mv-tabs";
            const video = document.createElement("video");
            video.className = "asd-mv-video";
            video.controls = true;
            video.preload = "metadata";
            cajaVideo.append(pestanas, video);
            inner.appendChild(cajaVideo);

            let finales = [];
            let cualVideo = 0;

            const pintarVideo = () => {
                if (!finales.length) {
                    cajaVideo.hidden = true;
                    // Parar la descarga de un mp4 que ya no se muestra.
                    video.removeAttribute("src");
                    video.load();
                    ajustar();
                    return;
                }
                if (cualVideo >= finales.length) cualVideo = 0;
                cajaVideo.hidden = false;

                pestanas.innerHTML = "";
                finales.forEach((f, i) => {
                    const b = document.createElement("button");
                    b.className = "asd-mv-tab" + (i === cualVideo ? " sel" : "");
                    b.innerText = `${f.label}  ·  ${f.mb} MB`;
                    b.addEventListener("click", () => {
                        if (i === cualVideo) return;
                        cualVideo = i;
                        pintarVideo();
                    });
                    pestanas.appendChild(b);
                });

                const f = finales[cualVideo];
                // `mtime` en la URL: sin el, rehacer el montaje deja al navegador
                // sirviendo de cache el video anterior, con el mismo nombre.
                // `mtime` in the URL: without it, re-cutting leaves the browser
                // serving the previous video from cache under the same name.
                const url = api.apiURL(`/view?filename=${encodeURIComponent(f.filename)}`
                    + `&subfolder=${encodeURIComponent(f.subfolder)}&type=output&t=${f.mtime}`);
                if (video.getAttribute("src") !== url) {
                    video.setAttribute("src", url);
                    video.load();
                }
                ajustar();
            };

            // ---- tamaño ----
            //
            // El alto es "donde empieza el widget DOM" + "lo que mide su
            // contenido". Lo primero NO se estima: LiteGraph lo deja escrito en
            // `last_y` al dibujar, ya con el titulo, los zocalos y los widgets
            // nativos descontados. Calcularlo a ojo (60 + filas * 22) lo cuenta
            // dos veces y deja un hueco muerto debajo de la consola.
            //
            // Height is "where the DOM widget starts" plus "how tall its content
            // is". The first half is NOT estimated: LiteGraph writes it into
            // `last_y` while drawing, with the title, slots and native widgets
            // already accounted for. Guessing it (60 + rows * 22) counts them
            // twice and leaves dead space under the console.
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
            this.computeSize = function () {
                const h = (inner.scrollHeight || 240) + 2 * MARGEN_DOM + 6;
                if (domW && typeof domW.last_y === "number" && domW.last_y > 0) {
                    return [ANCHO_MIN, domW.last_y + h];
                }
                // Solo hasta el primer dibujado, cuando aun no hay last_y.
                const nIn = this.inputs ? this.inputs.length : 0;
                const nOut = this.outputs ? this.outputs.length : 0;
                return [ANCHO_MIN, 60 + Math.max(nIn, nOut) * 22 + h];
            };

            const originalOnResize = this.onResize;
            this.onResize = function (size) {
                if (originalOnResize) originalOnResize.apply(this, arguments);
                const m = this.computeSize();
                if (size[1] < m[1]) size[1] = m[1];
                if (size[0] < m[0]) size[0] = m[0];
            };

            const ajustar = () => {
                if (_this._ajustando) return;
                _this._ajustando = true;
                requestAnimationFrame(() => {
                    try {
                        const alto = _this.computeSize()[1];
                        const ancho = Math.max(_this.size[0], ANCHO_MIN);
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

            // ---- estado ----
            const valor = (nombre, porDefecto) => {
                const w = _this.widgets ? _this.widgets.find((x) => x.name === nombre) : null;
                return w && w.value !== undefined && w.value !== null ? w.value : porDefecto;
            };

            // ---- a que proyecto apunta ----
            //
            // `path` casi siempre llega ENLAZADO desde Project Paths, y un enlace
            // solo tiene valor durante la ejecucion: el nodo de arriba calcula la
            // ruta y no la guarda en ningun widget. Lo que SI se puede leer es su
            // `project_name`, asi que se lee y se le pide al servidor la ruta que
            // saldria por el zocalo. La regla vive en un solo sitio.
            //
            // Se resuelve ANTES DE CADA ACCION, nunca se recuerda: cambiar de
            // proyecto tiene que cambiar el destino en el acto, porque uno de los
            // botones borra.
            //
            // `path` almost always arrives LINKED from Project Paths, and a link
            // only has a value during execution. What can be read is its
            // `project_name`, so the UI reads that and asks the server for the
            // path the connector would carry -- the rule lives in one place.
            // Resolved BEFORE EVERY ACTION and never remembered: switching
            // project has to change the target at once, because one of these
            // buttons deletes.
            // Un Reroute no es el origen, es un cable con forma de nodo: si no se
            // salta, leer "el widget de arriba" encuentra un nodo sin widgets y
            // el editor se queda con el valor viejo sin decir nada.
            // A Reroute is not the origin, it is a cable shaped like a node.
            const saltar = (n) => {
                let salto = 0;
                while (n && /reroute/i.test(n.type || "") && salto++ < 8) {
                    try {
                        n = n.getInputNode(0);
                    } catch (err) {
                        return null;
                    }
                }
                return n;
            };

            const origenDe = (nombre) => {
                const ent = _this.inputs || [];
                for (let i = 0; i < ent.length; i++) {
                    const e = ent[i];
                    if (e.name === nombre || (e.widget && e.widget.name === nombre)) {
                        if (e.link == null) return null;
                        try {
                            return saltar(_this.getInputNode(i));
                        } catch (err) {
                            return null;
                        }
                    }
                }
                return null;
            };

            // Para todo lo que NO sea `path`: si viene enlazado, el valor de
            // verdad esta en un widget del nodo de arriba y se puede leer tal
            // cual. `latent_frames` sale de Moviola Out, que es donde se decide.
            // Anything but `path`: when linked, the real value sits in an
            // upstream widget and reads straight off. `latent_frames` comes from
            // Moviola Out, which is where it is decided.
            const valorResuelto = (nombre, porDefecto) => {
                const n = origenDe(nombre);
                const w = n && n.widgets ? n.widgets.find((x) => x.name === nombre) : null;
                if (w && w.value !== undefined && w.value !== null) return w.value;
                return valor(nombre, porDefecto);
            };

            // Nombre de proyecto legible sin preguntar al servidor. Sirve para
            // detectar que ha cambiado; la ruta de verdad la da el servidor.
            const origenProyecto = () => {
                const n = origenDe("path");
                const w = n && n.widgets ? n.widgets.find((x) => x.name === "project_name") : null;
                if (w) return String(w.value || "");
                return String(valor("path", ""));
            };

            const resolverPath = async () => {
                const n = origenDe("path");
                const w = n && n.widgets ? n.widgets.find((x) => x.name === "project_name") : null;
                if (w) {
                    try {
                        const r = await pedirJSON("/academia/projectpaths/resolve",
                                                  { project_name: String(w.value || "") });
                        if (r.status === "success" && r.path) return r.path;
                    } catch (e) {}
                }
                return String(valor("path", ""));
            };

            const cuerpo = async () => ({
                path: await resolverPath(),
                latent_frames: parseInt(valorResuelto("latent_frames", 1), 10) || 1,
                crf: parseInt(valorResuelto("crf", 18), 10) || 18,
            });

            const escribir = (texto) => {
                consola.innerText = texto;
                consola.scrollTop = consola.scrollHeight;
                ajustar();
            };

            const ocupado = (si, etiqueta) => {
                [btnEdit, btnUndo, btnWipe, btnRefresh, btnFolder].forEach((b) => (b.disabled = si));
                if (si) escribir(etiqueta);
            };

            const llamar = async (url, extra, etiqueta) => {
                ocupado(true, etiqueta);
                try {
                    const r = await pedirJSON(url, Object.assign(await cuerpo(), extra || {}));
                    if (r.status === "success") {
                        escribir((r.log || [r.text || ""]).join("\n").trim() || "Done.");
                        // Toda respuesta trae los montajes que existan, asi que el
                        // reproductor aparece y desaparece solo: tras montar, y
                        // tras borrarlo todo. / Every response carries whatever
                        // cuts exist, so the player appears and vanishes on its own.
                        finales = Array.isArray(r.finals) ? r.finals : [];
                        pintarVideo();
                    } else {
                        escribir("Error: " + (r.message || "unknown"));
                    }
                } catch (e) {
                    escribir("Error: no answer from the server.");
                } finally {
                    ocupado(false);
                }
            };

            this.refrescarEstado = () =>
                llamar("/academia/moviola/status", null, "Reading the project...");

            // El boton existe porque la deteccion automatica solo ve lo que hay
            // AGUAS ARRIBA de este nodo. Si el proyecto cambia por otro camino
            // -- cargar un proyecto en el Multi-Prompt, renombrar una carpeta a
            // mano, borrar ficheros desde el explorador -- aqui no se entera
            // nadie. Esto vuelve a preguntarlo todo desde cero.
            //
            // The button exists because the automatic detection only sees what is
            // UPSTREAM of this node. If the project changes by another route --
            // loading a project in the Multi-Prompt, renaming a folder by hand,
            // deleting files from the file manager -- nothing here notices.
            btnRefresh.addEventListener("click", () => {
                _this._ultimoOrigen = null;   // que la deteccion no lo de por visto
                _this.refrescarEstado();
            });

            // La ruta que sale aqui es la MISMA que usan los botones de borrar,
            // resuelta por el servidor. Por eso este boton vale ademas como
            // comprobacion: si la carpeta que aparece no es la que el usuario
            // cree, se ve antes de darle a nada que borre.
            //
            // The path printed here is the SAME one the delete buttons act on,
            // resolved by the server. So this doubles as a check: if the folder
            // shown is not the one the user has in mind, that is visible before
            // pressing anything destructive.
            btnFolder.addEventListener("click", () =>
                llamar("/academia/moviola/folder", null, "Opening the folder..."));

            btnEdit.addEventListener("click", () =>
                llamar("/academia/moviola/edit", null,
                       "Measuring the seams and joining. This takes a while..."));

            // Borrar tomas no se deshace: se pregunta siempre, y al borrarlo todo
            // se dice cuantas vueltas se van por delante.
            // Deleting takes cannot be undone: always ask, and when wiping say how
            // many loops are going.
            // La pregunta NOMBRA el proyecto. Es la ultima red: si la ruta
            // resuelta no fuera la que el usuario cree, se lee aqui antes de que
            // desaparezca nada.
            // The confirmation NAMES the project -- the last net: if the resolved
            // path is not what the user thinks, it is readable here before
            // anything disappears.
            btnUndo.addEventListener("click", async () => {
                const p = await resolverPath();
                if (!confirm(`Delete the last loop of "${p}"?\n\nIts latent, its videos and `
                             + "every file numbered with it will be removed.\n"
                             + "This cannot be undone.")) return;
                llamar("/academia/moviola/delete", { all: false }, "Deleting the last loop...");
            });

            btnWipe.addEventListener("click", async () => {
                const p = await resolverPath();
                if (!confirm(`Delete EVERY loop of "${p}"?\n\nAll latents, all videos and `
                             + "the saved base image will be removed, leaving the project empty.\n"
                             + "This cannot be undone.")) return;
                llamar("/academia/moviola/delete", { all: true }, "Deleting every loop...");
            });

            container.addEventListener("mousedown", (e) => e.stopPropagation());
            container.addEventListener("wheel", (e) => {
                if (e.target === consola || consola.contains(e.target)) e.stopPropagation();
            });

            domW = this.addDOMWidget("UI", "HTML", container);

            // Mismo caso que la tira del Multi-Prompt: el recuento y el fotograma
            // de la vuelta los escribe Moviola Out al final, asi que la consola
            // solo dice la verdad una vez ha terminado TODA la ejecucion.
            // Same as the Multi-Prompt strip: the counts are only true once the
            // whole run has finished.
            const alTerminar = () => {
                if (_this.refrescarEstado) _this.refrescarEstado();
            };
            api.addEventListener("execution_success", alTerminar);

            const onRemoved = this.onRemoved;
            this.onRemoved = function () {
                if (_this._ro) _this._ro.disconnect();
                api.removeEventListener("execution_success", alTerminar);
                if (onRemoved) onRemoved.apply(this, arguments);
            };

            // El primer estado se pide con retraso: al crear el nodo todavia no
            // tiene id definitivo si viene de cargar un workflow.
            // The first status is delayed: a node loaded from a workflow does not
            // have its final id yet at creation time.
            setTimeout(() => _this.refrescarEstado(), 300);

            // Cambiar de proyecto tiene que reflejarse SIN pulsar nada: si no, la
            // consola seguiria enseñando las vueltas del proyecto anterior y eso
            // es justo lo que hay que evitar antes de darle a un boton de borrar.
            //
            // La comprobacion se hace leyendo un widget, sin ir al servidor, y
            // solo se pregunta cuando el valor ha cambiado de verdad.
            //
            // Switching project must show up WITHOUT pressing anything, or the
            // console would keep displaying the previous project's loops right
            // next to a delete button. The check reads a widget, no round trip,
            // and only asks the server when the value actually changed.
            const onDraw = this.onDrawForeground;
            this.onDrawForeground = function (ctx) {
                if (onDraw) onDraw.apply(this, arguments);
                if (this.flags && this.flags.collapsed) return;
                const ahora = origenProyecto() + "|" + valorResuelto("latent_frames", 1);
                if (ahora !== this._ultimoOrigen) {
                    this._ultimoOrigen = ahora;
                    if (this._vistoUnaVez) this.refrescarEstado();
                    this._vistoUnaVez = true;
                }
            };
        };

        // Al ejecutar el nodo, el servidor devuelve el estado ya resuelto -- que
        // es el unico momento en que se conoce `path` si llega por un enlace.
        // Executing returns the resolved status, the only moment `path` is known
        // when it arrives through a link.
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (mensaje) {
            if (onExecuted) onExecuted.apply(this, arguments);
            const t = mensaje && mensaje.asd_moviola;
            if (t && t.length && this._consola) {
                this._consola.innerText = String(t[0]);
            }
        };
    },
});
