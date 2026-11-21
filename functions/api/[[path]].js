/* Tout'zafer · relais de la page Gestion (Cloudflare Pages Functions)
 *
 * Routes :
 *   GET  /api/ping       -> {ok:true}                    (la page Gestion détecte ainsi le mode « relais »)
 *   GET  /api/catalogue  -> {catalogue:[...], sha}       (mot de passe requis)
 *   POST /api/save       <- {catalogue:"<json>", sha, files:[{path,data(base64)}], message}
 *                        -> {sha}                         (mot de passe requis ; 409 si modifié ailleurs)
 *
 * Variables d'environnement (Cloudflare > projet > Settings > Variables and Secrets) :
 *   ADMIN_PASSWORD  mot de passe de la page Gestion            (secret)
 *   GITHUB_TOKEN    clé GitHub fine-grained, dépôt seul, Contents: Read and write (secret)
 *   GITHUB_REPO     ex. "Souweyd/toutzafer"   (facultatif, valeur par défaut ci-dessous)
 *   GITHUB_BRANCH   ex. "main"                (facultatif)
 * La clé GitHub ne quitte jamais le serveur : la page n'envoie que le mot de passe.
 */
const FILE = "catalogue.json";
const PHOTO_PATH = /^img\/w\/a\d{2,4}-u\d{1,3}-(360|720)\.(webp|jpg)$/;
const MAX_FILES = 24, MAX_FILE_B64 = 2_000_000, MAX_CATALOGUE = 1_000_000;

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function sameText(a, b) {               // comparaison à durée constante
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

async function checkPassword(request, env) {
  if (!env.ADMIN_PASSWORD || !env.GITHUB_TOKEN) throw new HttpError(500, "Relais non configuré (ADMIN_PASSWORD ou GITHUB_TOKEN manquant).");
  if (!sameText(request.headers.get("X-Gestion-Password") || "", env.ADMIN_PASSWORD)) {
    await new Promise(r => setTimeout(r, 600)); // ralentit les essais au hasard
    throw new HttpError(401, "Mot de passe incorrect.");
  }
}

function gh(env) {
  const repo = env.GITHUB_REPO || "Souweyd/toutzafer", branch = env.GITHUB_BRANCH || "main";
  const base = (env.GITHUB_API || "https://api.github.com") + "/repos/" + repo;
  async function api(path, opt = {}) {
    const r = await fetch(base + path, {
      ...opt,
      headers: {
        "Accept": "application/vnd.github+json", "Authorization": "Bearer " + env.GITHUB_TOKEN,
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "toutzafer-gestion",
        ...(opt.body ? { "Content-Type": "application/json" } : {})
      }
    });
    if (r.status === 409 || r.status === 422) throw new HttpError(409, "Le catalogue a été modifié ailleurs.");
    if (r.status === 401 || r.status === 403) throw new HttpError(502, "GitHub refuse la clé du relais (expirée ou sans droit d'écriture).");
    if (!r.ok) throw new HttpError(502, "GitHub a répondu " + r.status + ".");
    return r.status === 204 ? null : r.json();
  }
  return { api, branch };
}

const b64ToText = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), c => c.charCodeAt(0)));
function textToB64(s) {
  const bytes = new TextEncoder().encode(s); let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function validCatalogue(text) {
  if (typeof text !== "string" || text.length > MAX_CATALOGUE) throw new HttpError(400, "Catalogue trop volumineux ou absent.");
  let list; try { list = JSON.parse(text); } catch (e) { throw new HttpError(400, "Catalogue illisible."); }
  if (!Array.isArray(list)) throw new HttpError(400, "Catalogue invalide.");
  const ids = new Set();
  for (const p of list) {
    if (!p || !/^a\d{2,4}$/.test(p.id) || ids.has(p.id)) throw new HttpError(400, "Identifiant d'article invalide ou en double.");
    ids.add(p.id);
    if (typeof p.name !== "string" || !p.name.trim() || typeof p.price !== "number" || !(p.price >= 0)) throw new HttpError(400, "Article " + p.id + " incomplet.");
    if (!Array.isArray(p.base)) throw new HttpError(400, "Article " + p.id + " sans liste de photos.");
  }
  return list;
}

async function load(env) {
  const { api, branch } = gh(env);
  const j = await api(`/contents/${FILE}?ref=${branch}`);
  return { catalogue: JSON.parse(b64ToText(j.content)), sha: j.sha };
}

async function save(env, body) {
  const { catalogue, sha, files = [], message } = body || {};
  validCatalogue(catalogue);
  if (typeof sha !== "string") throw new HttpError(400, "Version du catalogue manquante.");
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new HttpError(400, "Trop de photos en une fois.");
  for (const f of files) {
    if (!f || !PHOTO_PATH.test(f.path) || typeof f.data !== "string" || f.data.length > MAX_FILE_B64) throw new HttpError(400, "Photo refusée : " + (f && f.path));
  }
  const { api, branch } = gh(env);
  const head = (await api(`/git/ref/heads/${branch}`)).object.sha;
  const cur = await api(`/contents/${FILE}?ref=${head}`);
  if (cur.sha !== sha) throw new HttpError(409, "Le catalogue a été modifié ailleurs.");
  const baseTree = (await api(`/git/commits/${head}`)).tree.sha;
  const tree = [];
  for (const f of files) {
    const b = await api("/git/blobs", { method: "POST", body: JSON.stringify({ content: f.data, encoding: "base64" }) });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: b.sha });
  }
  const cat = await api("/git/blobs", { method: "POST", body: JSON.stringify({ content: textToB64(catalogue), encoding: "base64" }) });
  tree.push({ path: FILE, mode: "100644", type: "blob", sha: cat.sha });
  const t = await api("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree }) });
  const msg = String(message || "Gestion : mise à jour du catalogue").replace(/[\r\n]+/g, " ").slice(0, 300);
  const c = await api("/git/commits", { method: "POST", body: JSON.stringify({ message: msg, tree: t.sha, parents: [head] }) });
  await api(`/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: c.sha, force: false }) });
  return { sha: cat.sha };
}

export async function onRequest({ request, env, params }) {
  const route = [].concat(params.path || []).join("/");
  try {
    if (route === "ping" && request.method === "GET") return json({ ok: true });
    if (route === "catalogue" && request.method === "GET") { await checkPassword(request, env); return json(await load(env)); }
    if (route === "save" && request.method === "POST") {
      await checkPassword(request, env);
      let body; try { body = await request.json(); } catch (e) { throw new HttpError(400, "Requête illisible."); }
      return json(await save(env, body));
    }
    return json({ error: "Introuvable" }, 404);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e.message || "Erreur interne" }, status);
  }
}
