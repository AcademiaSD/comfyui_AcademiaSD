import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Long Video: dos barras propias porque ComfyUI solo tiene una por nodo, y RelayVSR
// nativo la reinicia en cada ventana. Python envia el estado en asd_relayvsr_progress.
// Debajo van la entrada y el MP4 final, que se guarda con el workflow; con los dos
// cargados se ven superpuestos en un canvas con una cortinilla que se arrastra. La entrada y
// la subida son propias porque las de ComfyUI no aceptan AVI: si el navegador no
// puede reproducir el archivo, Python prepara un MP4 pequeno solo para verlo.
const NODE_NAMES = ["AcademiaSD_RelayVSRVideoFile", "AcademiaSD_RelayVSRNativeVideo"];
const ACCEPT = "video/*,.avi,.mkv,.mov,.wmv,.flv,.m4v,.mpg,.mpeg,.ts,.mts,.webm";

const CSS = `
.asd-rv { display:flex; flex-direction:column; gap:6px; height:100%; padding:4px 2px; box-sizing:border-box; font:11px 'Segoe UI', system-ui, sans-serif; color:#bbb; }
.asd-rv video { flex:1 1 0; min-height:0; width:100%; background:#111; border-radius:6px; }
.asd-rv [hidden] { display:none; }
.asd-rv-result { font-weight:600; color:#ddd; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.asd-rv-size { text-align:center; font-variant-numeric:tabular-nums; margin-top:-2px; }
.asd-rv-cmp { position:relative; flex:1 1 0; min-height:0; background:#111; border-radius:6px; overflow:hidden; }
.asd-rv-cmp canvas { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; cursor:ew-resize; touch-action:none; }
.asd-rv-tag { position:absolute; top:6px; padding:1px 7px; border-radius:4px; background:#0009; color:#fff; font-size:12px; pointer-events:none; }
.asd-rv-tag.a { left:6px; } .asd-rv-tag.b { right:6px; }
.asd-rv-bar { display:flex; align-items:center; gap:6px; }
.asd-rv-bar button { background:#1f4a35; border:1px solid #3f8f58; border-radius:5px; color:#c8f7d6; padding:3px 9px; font:inherit; font-weight:600; min-width:64px; cursor:pointer; }
.asd-rv-bar input { flex:1; min-width:0; }
.asd-rv-bar span { color:#aaa; min-width:84px; text-align:right; font-variant-numeric:tabular-nums; }
.asd-rv-row { display:flex; flex-direction:column; gap:2px; }
.asd-rv-text { display:flex; justify-content:space-between; gap:8px; font-variant-numeric:tabular-nums; }
.asd-rv-text span:first-child { font-weight:600; color:#ddd; }
.asd-rv-track { height:8px; border-radius:4px; background:#2b2f36; overflow:hidden; }
.asd-rv-fill { height:100%; width:0; border-radius:4px; background:#3f8f58; transition:width .2s; }
.asd-rv-row.part .asd-rv-fill { background:#7fd3ff; }
.asd-rv-row.pulse .asd-rv-fill { width:35% !important; animation:asd-rv-pulse 1.4s ease-in-out infinite alternate; }
@keyframes asd-rv-pulse { from { margin-left:0; } to { margin-left:65%; } }
`;

function duracion(segundos) {
    const s = Math.round(segundos);
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function fila(titulo, clase) {
    const el = document.createElement("div");
    el.className = `asd-rv-row ${clase}`;
    el.innerHTML = `<div class="asd-rv-text"><span>${titulo}</span><span></span></div><div class="asd-rv-track"><div class="asd-rv-fill"></div></div>`;
    const [nombre, valor] = el.querySelectorAll(".asd-rv-text span");
    return { el, nombre, valor, relleno: el.querySelector(".asd-rv-fill") };
}

function reproductor(nombre) {
    const titulo = document.createElement("div");
    titulo.className = "asd-rv-result";
    titulo.hidden = true;
    const video = document.createElement("video");
    video.controls = true;
    video.loop = true;
    video.playsInline = true;
    video.hidden = true;
    video.addEventListener("pointerdown", (e) => e.stopPropagation());
    const tamano = document.createElement("div");
    tamano.className = "asd-rv-size";
    tamano.hidden = true;
    return {
        titulo, video, tamano,
        medida(ancho, alto) {
            tamano.textContent = `${ancho} × ${alto}`;
            tamano.hidden = false;
        },
        mostrar(texto, src) {
            titulo.textContent = `${nombre}: ${texto}`;
            titulo.hidden = false;
            tamano.hidden = true;
            video.hidden = !src;
            if (src) video.src = src;
            else {
                video.removeAttribute("src");
                video.load();
            }
        },
    };
}

async function subir(file) {
    const body = new FormData();
    body.append("image", file);
    const res = await api.fetchApi("/upload/image", { method: "POST", body });
    if (res.status !== 200) throw new Error(`${res.status} ${res.statusText}`);
    const { name, subfolder } = await res.json();
    return subfolder ? `${subfolder}/${name}` : name;
}

function reloj(segundos) {
    const s = Math.floor(segundos || 0);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function pintar(f, hecho, total, texto) {
    f.el.classList.remove("pulse");
    f.relleno.style.width = `${total ? (100 * hecho) / total : 0}%`;
    f.valor.textContent = texto;
}

app.registerExtension({
    name: "AcademiaSD.RelayVSRProgress",
    async setup() {
        const s = document.createElement("style");
        s.textContent = CSS;
        document.head.appendChild(s);

        api.addEventListener("asd_relayvsr_progress", ({ detail }) => {
            const id = String(detail.node).split(":").pop();
            app.graph.getNodeById(Number(id))?.asdProgreso?.(detail);
        });
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_NAMES.includes(nodeData.name)) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const root = document.createElement("div");
            root.className = "asd-rv";
            const total = fila("Total", "total");
            const parte = fila("Part", "part");
            const entrada = reproductor("Input");
            const resultado = reproductor("Result");
            const vista = document.createElement("div");
            vista.className = "asd-rv-cmp";
            vista.hidden = true;
            vista.innerHTML = `<canvas></canvas><div class="asd-rv-tag a">Before</div><div class="asd-rv-tag b">After</div>`;
            const controles = document.createElement("div");
            controles.className = "asd-rv-bar";
            controles.hidden = true;
            controles.innerHTML = `<button>▶ Play</button><input type="range" min="0" max="1000" value="0"><span>0:00 / 0:00</span>`;
            root.append(total.el, parte.el, entrada.titulo, entrada.video, entrada.tamano, resultado.titulo, resultado.video, resultado.tamano, vista, controles);
            const self = this;
            this.properties = Object.assign({ asd_video: null }, this.properties);
            const crecer = () => {
                const alto = 360 + (entrada.video.hidden ? 0 : 340) + (resultado.video.hidden ? 0 : 340) + (vista.hidden ? 0 : 440);
                if (self.size[1] < alto) self.setSize([Math.max(self.size[0], 560), alto]);
            };

            // Comparacion: el resultado manda (lleva el audio) y la entrada lo sigue.
            const antes = entrada.video, despues = resultado.video;
            const lienzo = vista.querySelector("canvas");
            const contexto = lienzo.getContext("2d");
            const [btnPlay, barra, tiempo] = controles.children;
            let divisor = 0.5;
            const dibujar = () => {
                const ancho = despues.videoWidth, alto = despues.videoHeight;
                if (vista.hidden || !ancho) return;
                if (lienzo.width !== ancho || lienzo.height !== alto) { lienzo.width = ancho; lienzo.height = alto; }
                const x = Math.round(ancho * divisor);
                contexto.drawImage(despues, 0, 0, ancho, alto);
                if (x > 0 && antes.videoWidth) contexto.drawImage(antes, 0, 0, (antes.videoWidth * x) / ancho, antes.videoHeight, 0, 0, x, alto);
                contexto.fillStyle = "#fff";
                contexto.fillRect(x - 1, 0, Math.max(2, Math.round(ancho / 640)), alto);
                tiempo.textContent = `${reloj(despues.currentTime)} / ${reloj(despues.duration)}`;
                if (!barra.matches(":active")) barra.value = (1000 * despues.currentTime) / (despues.duration || 1);
            };
            // Los <video> estan ocultos y no entregan requestVideoFrameCallback: se pinta por animationFrame.
            const alFrame = () => {
                if (vista.hidden || despues.paused) return;
                if (Math.abs(antes.currentTime - despues.currentTime) > 0.1) antes.currentTime = despues.currentTime;
                dibujar();
                requestAnimationFrame(alFrame);
            };
            const comparar = () => {
                const activo = antes.readyState >= 2 && despues.readyState >= 2 && !!antes.getAttribute("src") && !!despues.getAttribute("src");
                vista.hidden = controles.hidden = !activo;
                antes.hidden = activo || !antes.getAttribute("src");
                despues.hidden = activo || !despues.getAttribute("src");
                antes.muted = activo;
                if (activo) {
                    despues.pause();
                    antes.pause();
                    antes.currentTime = despues.currentTime;
                }
                crecer();
                dibujar();
            };
            for (const v of [antes, despues]) {
                v.addEventListener("loadeddata", comparar);
                v.addEventListener("emptied", comparar);
                v.addEventListener("seeked", dibujar);
            }
            despues.addEventListener("play", () => {
                btnPlay.textContent = "❚❚ Pause";
                if (vista.hidden) return;
                antes.play().catch(() => {});
                requestAnimationFrame(alFrame);
            });
            despues.addEventListener("pause", () => { antes.pause(); btnPlay.textContent = "▶ Play"; });
            btnPlay.onclick = () => (despues.paused ? despues.play() : despues.pause());
            barra.oninput = () => {
                despues.pause();
                despues.currentTime = antes.currentTime = (barra.value / 1000) * (despues.duration || 0);
            };
            // object-fit deja bandas: la posicion se mide sobre la imagen, no sobre el canvas.
            const mover = (e) => {
                const caja = lienzo.getBoundingClientRect();
                const ancho = Math.min(caja.width, (caja.height * lienzo.width) / (lienzo.height || 1));
                divisor = Math.min(1, Math.max(0, (e.clientX - caja.left - (caja.width - ancho) / 2) / ancho));
                dibujar();
            };
            // En fase de captura: con Nodes 2.0 el WidgetDOM hace stop de pointermove y pointerup.
            const soltar = () => {
                window.removeEventListener("pointermove", mover, true);
                window.removeEventListener("pointerup", soltar, true);
                window.removeEventListener("pointercancel", soltar, true);
            };
            lienzo.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                e.preventDefault();
                mover(e);
                window.addEventListener("pointermove", mover, true);
                window.addEventListener("pointerup", soltar, true);
                window.addEventListener("pointercancel", soltar, true);
            });

            const archivo = this.widgets.find((w) => w.name === "video");
            let convertido = false;
            this.asdEntrada = () => {
                convertido = false;
                if (self.inputs?.find((i) => i.name === "video_input")?.link != null) return entrada.mostrar("video_input", null);
                if (!archivo.value) return entrada.mostrar("none", null);
                const q = new URLSearchParams({ filename: archivo.value, type: "input", rand: Date.now() });
                entrada.mostrar(archivo.value, api.apiURL(`/view?${q}`));
                crecer();
            };
            // Lo que el navegador no reproduce, como AVI, pasa a un MP4 de vista previa.
            entrada.video.addEventListener("error", () => {
                if (!archivo.value) return;
                if (convertido) return entrada.mostrar(`${archivo.value} (no preview)`, null);
                convertido = true;
                entrada.titulo.textContent = `Input: ${archivo.value} (preparing preview…)`;
                entrada.video.src = api.apiURL(`/academia/relayvsr/preview?${new URLSearchParams({ filename: archivo.value })}`);
            });
            // La vista previa convertida es mas pequena: la medida real la da Python.
            entrada.video.addEventListener("loadedmetadata", async () => {
                if (!convertido) return entrada.medida(entrada.video.videoWidth, entrada.video.videoHeight);
                entrada.titulo.textContent = `Input: ${archivo.value} (preview)`;
                const nombre = archivo.value;
                const res = await api.fetchApi(`/academia/relayvsr/size?${new URLSearchParams({ filename: nombre })}`);
                if (res.ok && archivo.value === nombre) {
                    const { width, height } = await res.json();
                    entrada.medida(width, height);
                }
            });
            const alCambiar = archivo.callback;
            archivo.callback = function () {
                const r = alCambiar?.apply(this, arguments);
                self.asdEntrada();
                return r;
            };

            const selector = document.createElement("input");
            selector.type = "file";
            selector.accept = ACCEPT;
            selector.onchange = () => {
                const file = selector.files?.[0];
                selector.value = "";
                if (file) self.asdSubir(file);
            };
            this.asdSubir = async (file) => {
                try {
                    const nombre = await subir(file);
                    if (!archivo.options.values.includes(nombre)) archivo.options.values.push(nombre);
                    archivo.value = nombre;
                    archivo.callback(nombre);
                } catch (e) {
                    app.extensionManager?.toast?.add({ severity: "error", summary: "Upload failed", detail: `${file.name}: ${e.message}`, life: 6000 });
                }
            };
            this.addWidget("button", "choose video to upload", null, () => selector.click()).serialize = false;

            this.asdMostrar = () => {
                const v = self.properties.asd_video;
                if (!v) return;
                const q = new URLSearchParams({ filename: v.filename, subfolder: v.subfolder, type: v.type, rand: Date.now() });
                resultado.mostrar(v.filename, api.apiURL(`/view?${q}`));
                crecer();
            };
            resultado.video.addEventListener("loadedmetadata", () => resultado.medida(resultado.video.videoWidth, resultado.video.videoHeight));
            resultado.video.addEventListener("error", () => {
                if (!resultado.video.getAttribute("src")) return;
                resultado.mostrar("", null);
                resultado.titulo.hidden = true;
            });

            this.asdProgreso = (p) => {
                const tiempo = p.eta == null ? "" : ` · ${duracion(p.eta)} left`;
                pintar(total, p.frames_done, p.frames, `${p.frames_done} / ${p.frames || "?"}${tiempo}`);
                if (p.phase === "wan") {
                    parte.nombre.textContent = "Wan references";
                    pintar(parte, p.part_done, p.part_size, `${p.part_done} / ${p.part_size}`);
                } else if (p.phase === "parts") {
                    parte.nombre.textContent = `Part ${p.part} / ${p.parts}`;
                    pintar(parte, p.part_done, p.part_size, `${p.part_done} / ${p.part_size}`);
                } else {
                    parte.nombre.textContent = p.phase === "join" ? "Joining parts" : "Done";
                    pintar(parte, 1, 1, "");
                    parte.el.classList.toggle("pulse", p.phase === "join");
                }
            };

            this.addDOMWidget("relayvsr_progress", "relayvsr_progress", root, {
                getMinHeight: () => 72 + (entrada.video.hidden ? 0 : 200) + (resultado.video.hidden ? 0 : 200) + (vista.hidden ? 0 : 260),
                serialize: false,
            });
            this.asdEntrada();
            return r;
        };

        // Los valores y propiedades guardados llegan despues de onNodeCreated.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this.asdEntrada?.();
            this.asdMostrar?.();
            return r;
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            const r = onConnectionsChange?.apply(this, arguments);
            this.asdEntrada?.();
            return r;
        };

        nodeType.prototype.onDragOver = function (e) {
            return !!e?.dataTransfer?.types?.includes("Files");
        };
        nodeType.prototype.onDragDrop = function (e) {
            const file = e?.dataTransfer?.files?.[0];
            if (!file) return false;
            this.asdSubir(file);
            return true;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            if (message?.asd_video?.length) {
                this.properties.asd_video = message.asd_video[0];
                this.asdMostrar?.();
            }
        };
    },
});
