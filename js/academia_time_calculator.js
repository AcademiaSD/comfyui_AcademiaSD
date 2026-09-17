import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.TimeCalculator",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {

        if (nodeData.name === "AcademiaSD_TimeCalculator") {

            // Al terminar la ejecucion llegan los valores de verdad, los mismos
            // con los que se han calculado las salidas.
            // When the run finishes the real values arrive -- the same ones the
            // outputs were computed from.
            const onExecuted = nodeType.prototype.onExecuted;

            nodeType.prototype.onExecuted = function (mensaje) {

                if (onExecuted)
                    onExecuted.apply(this, arguments);

                const d = mensaje && mensaje.asd_tiempo && mensaje.asd_tiempo[0];

                if (d && typeof d.duration === "number") {
                    this._asdTiempo = d;
                    if (this._asdRefrescar) this._asdRefrescar();
                }
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;

            nodeType.prototype.onNodeCreated = function () {

                if (onNodeCreated)
                    onNodeCreated.apply(this, arguments);


                // =====================================================
                // LOCALIZAR WIDGETS
                // =====================================================

                const framesWidget =
                    this.widgets.find(w => w.name === "frames");

                const fpsWidget =
                    this.widgets.find(w => w.name === "fps");


                // =====================================================
                // DISPLAY DE DURACIÓN
                // =====================================================

                const container =
                    document.createElement("div");

                container.style.cssText = `
                    width: 100%;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    padding: 8px;
                    box-sizing: border-box;
                    background: #111;
                    border-radius: 6px;
                    border: 1px solid #444;
                    margin-top: 10px;
                    box-shadow: inset 0 0 10px rgba(0,0,0,0.8);
                `;


                const timeLabel =
                    document.createElement("div");

                timeLabel.style.cssText = `
                    color: #00ff00;
                    font-size: 16px;
                    font-weight: bold;
                    font-family: monospace;
                    text-shadow: 0 0 5px #00ff00;
                `;

                timeLabel.innerText =
                    "⏱️ 0.00s";


                container.appendChild(timeLabel);


                // =====================================================
                // CALCULAR DURACIÓN
                // =====================================================

                // Una entrada ENLAZADA manda sobre su widget: el widget conserva
                // su valor por defecto y no tiene forma de enterarse de lo que
                // viaja por el cable. Lo que viaja solo se sabe al ejecutar, y
                // llega por `onExecuted`.
                //
                // A LINKED input beats its widget: the widget keeps its default
                // and has no way of knowing what travels down the wire. What
                // travels is only known once the node runs, and arrives through
                // `onExecuted`.
                const enlazada = (nombre) => {
                    const ent = this.inputs || [];
                    for (let i = 0; i < ent.length; i++) {
                        const e = ent[i];
                        const suyo = e.name === nombre ||
                            (e.widget && e.widget.name === nombre);
                        if (suyo && e.link != null) return true;
                    }
                    return false;
                };

                const updateTime = () => {

                    if (!framesWidget || !fpsWidget)
                        return;

                    const ej = this._asdTiempo;

                    // Enlazado y sin ejecutar todavia: no se sabe. Se dice, en vez
                    // de ensenar la cuenta del valor por defecto, que seria un
                    // numero con toda la pinta de ser cierto.
                    // Linked and not run yet: unknown. Say so, rather than show the
                    // default's result, which would look entirely trustworthy.
                    if (!ej && (enlazada("frames") || enlazada("fps"))) {
                        timeLabel.innerText = "\u23f1\ufe0f \u2014";
                        return;
                    }

                    const frames = (ej && enlazada("frames"))
                        ? ej.frames
                        : parseInt(framesWidget.value);

                    const fps = (ej && enlazada("fps"))
                        ? ej.fps
                        : parseFloat(fpsWidget.value);


                    if (
                        !isNaN(frames) &&
                        !isNaN(fps) &&
                        fps > 0
                    ) {

                        const seconds =
                            frames / fps;

                        timeLabel.innerText =
                            `⏱️ ${seconds.toFixed(2)}s`;

                    } else {

                        timeLabel.innerText =
                            "⏱️ Error";
                    }
                };


                // =====================================================
                // EVENTO FRAMES
                // =====================================================

                if (framesWidget) {

                    const originalFramesCallback =
                        framesWidget.callback;

                    framesWidget.callback =
                        function() {

                            if (originalFramesCallback)
                                originalFramesCallback.apply(
                                    this,
                                    arguments
                                );

                            updateTime();
                        };
                }


                // =====================================================
                // EVENTO FPS
                // =====================================================

                if (fpsWidget) {

                    const originalFpsCallback =
                        fpsWidget.callback;

                    fpsWidget.callback =
                        function() {

                            if (originalFpsCallback)
                                originalFpsCallback.apply(
                                    this,
                                    arguments
                                );

                            updateTime();
                        };
                }


                // =====================================================
                // EVITAR QUE EL DISPLAY MUEVA EL NODO
                // =====================================================

                container.addEventListener(
                    "mousedown",
                    (e) => e.stopPropagation()
                );


                // =====================================================
                // INSERTAR DISPLAY
                // =====================================================

                this.addDOMWidget(
                    "Display",
                    "HTML",
                    container
                );


                // =====================================================
                // TAMAÑO DEL NODO
                // =====================================================

                const MIN_WIDTH = 180;


                this.computeSize =
                    function(out) {

                        let baseH = 80;

                        let htmlH = 60;

                        return [
                            MIN_WIDTH,
                            baseH + htmlH
                        ];
                    };


                const originalOnResize =
                    this.onResize;


                this.onResize =
                    function(size) {

                        if (originalOnResize)
                            originalOnResize.apply(
                                this,
                                arguments
                            );


                        const minSize =
                            this.computeSize();


                        if (size[1] < minSize[1])
                            size[1] = minSize[1];

                        if (size[0] < minSize[0])
                            size[0] = minSize[0];
                    };


                // =====================================================
                // ACTUALIZACIÓN INICIAL
                // =====================================================

                // Se deja a mano para que `onExecuted`, que vive fuera de aqui,
                // pueda repintar sin duplicar la cuenta.
                // Exposed so `onExecuted`, which lives outside this closure, can
                // repaint without duplicating the arithmetic.
                this._asdRefrescar = updateTime;

                setTimeout(() => {

                    updateTime();

                    const minSize =
                        this.computeSize();

                    this.setSize([
                        Math.max(
                            this.size[0],
                            MIN_WIDTH
                        ),
                        minSize[1]
                    ]);

                }, 100);
            };
        }
    }
});