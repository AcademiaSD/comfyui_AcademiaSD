import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Long Video: dos barras propias porque ComfyUI solo tiene una por nodo, y RelayVSR
// nativo la reinicia en cada ventana. Python envia el estado en asd_relayvsr_progress.
// Debajo van la entrada y el MP4 final, que se guarda con el workflow. La entrada y
// la subida son propias porque las de ComfyUI no aceptan AVI: si el navegador no
// puede reproducir el archivo, Python prepara un MP4 pequeno solo para verlo.
const NODE_NAMES = ["AcademiaSD_RelayVSRVideoFile", "AcademiaSD_RelayVSRNativeVideo"];
const ACCEPT = "video/*,.avi,.mkv,.mov,.wmv,.flv,.m4v,.mpg,.mpeg,.ts,.mts,.webm";

const CSS = `
.asd-rv { display:flex; flex-direction:column; gap:6px; height:100%; padding:4px 2px; box-sizing:border-box; font:11px 'Segoe UI', system-ui, sans-serif; color:#bbb; }
.asd-rv video { flex:1 1 0; min-height:0; width:100%; background:#111; border-radius:6px; }
.asd-rv [hidden] { display:none; }
.asd-rv-result { font-weight:600; color:#ddd; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
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
    return {
        titulo, video,
        mostrar(texto, src) {
            titulo.textContent = `${nombre}: ${texto}`;
            titulo.hidden = false;
            video.hidden = !src;
            if (src) video.src = src;
            else video.removeAttribute("src");
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
            root.append(total.el, parte.el, entrada.titulo, entrada.video, resultado.titulo, resultado.video);
            const self = this;
            this.properties = Object.assign({ asd_video: null }, this.properties);
            const crecer = () => {
                const alto = 360 + (entrada.video.hidden ? 0 : 340) + (resultado.video.hidden ? 0 : 340);
                if (self.size[1] < alto) self.setSize([Math.max(self.size[0], 560), alto]);
            };

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
            entrada.video.addEventListener("loadeddata", () => {
                if (convertido) entrada.titulo.textContent = `Input: ${archivo.value} (preview)`;
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
            resultado.video.addEventListener("error", () => { resultado.video.hidden = true; resultado.titulo.hidden = true; });

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
                getMinHeight: () => 72 + (entrada.video.hidden ? 0 : 200) + (resultado.video.hidden ? 0 : 200),
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
