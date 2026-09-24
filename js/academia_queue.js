import { api } from "../../scripts/api.js";

// Encolar un prompt pequeno que no es el workflow -- un mapa de ControlNet, una
// mejora de prompt -- y esperar sus resultados. Pasa por la cola normal, asi
// que la VRAM, la descarga de modelos y los errores los lleva ComfyUI.

// El final llega por el websocket, y puede llegar antes que la respuesta del
// POST que lo encola: se apunta por si alguien lo pide despues.
const waiters = new Map();
const ended = new Map();
for (const ev of ["execution_success", "execution_error", "execution_interrupted"]) {
    api.addEventListener(ev, ({ detail }) => {
        const id = detail?.prompt_id;
        if (!id) return;
        const waiter = waiters.get(id);
        if (waiter) {
            waiters.delete(id);
            waiter({ ev, detail });
            return;
        }
        ended.set(id, { ev, detail });
        if (ended.size > 64) ended.delete(ended.keys().next().value);
    });
}
const waitFor = (id) => new Promise((resolve) => {
    const done = ended.get(id);
    if (done) { ended.delete(id); resolve(done); } else waiters.set(id, resolve);
});

// Devuelve los outputs de la historia de ese prompt, por id de nodo.
export async function runPrompt(prompt) {
    const resp = await api.fetchApi("/prompt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: api.clientId }),
    });
    const queued = await resp.json();
    if (!resp.ok) {
        const nodeErr = Object.values(queued.node_errors || {})[0]?.errors?.[0];
        throw new Error(nodeErr ? `${nodeErr.message}: ${nodeErr.details}` : queued.error?.message || "not queued");
    }
    const { ev, detail } = await waitFor(queued.prompt_id);
    if (ev !== "execution_success") throw new Error(detail.exception_message || "interrupted");
    const hist = await (await api.fetchApi(`/history/${queued.prompt_id}`)).json();
    return hist[queued.prompt_id]?.outputs || {};
}
