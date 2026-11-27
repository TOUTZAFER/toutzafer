/* Tout'zafer · fonctions du site (Cloudflare Pages Functions)
 *
 * Catalogue (page Gestion, mot de passe requis) :
 *   GET  /api/ping            -> {ok:true, db}             (la page Gestion détecte ainsi le mode « relais »)
 *   GET  /api/catalogue       -> {catalogue:[...], sha}
 *   POST /api/save            <- {catalogue:"<json>", sha, files:[{path,data(base64)}], message} -> {sha} (409 si modifié ailleurs)
 *
 * Demandes des clients (base Cloudflare D1, liaison « DB ») :
 *   POST /api/demande         public : enregistre la demande envoyée depuis la boutique et prévient l'entrepreneur
 *   GET  /api/orders          -> {orders:[...]}                                   (mot de passe)
 *   POST /api/order-update    <- {id, patch}       -> {order}                     (mot de passe)
 *   POST /api/order-create    <- {order}           -> {order}  (demande collée ou saisie à la main)
 *   POST /api/order-delete    <- {id}              -> {ok}
 *   GET  /api/settings        -> réglages internes (fiches livreurs, notes des points, motifs, modèle de message)
 *   POST /api/settings        <- une partie de ces réglages (clés absentes inchangées)
 *   GET  /api/config          -> {config, sha}  réglages publics (reglages.json : numéro, points de livraison)
 *   POST /api/config          <- {config, sha}  enregistre reglages.json dans le dépôt (409 si modifié ailleurs)
 *
 * Mesure d'audience anonyme (compteurs par jour, sans cookie, sans identifiant, sans adresse IP conservée) :
 *   POST /api/stat            public : {e:[[type, valeur?], ...]} -> 204
 *   GET  /api/stats?from&to   (mot de passe) -> {first, daily:{jour:{visit,view,add,cart,form,sent}}, totals:{clé:n}}
 *
 * Notifications (Web Push, clés VAPID créées automatiquement et gardées dans la base) :
 *   GET  /api/push-key        -> {key}
 *   POST /api/push-subscribe  <- {sub, label}      (mot de passe)
 *   POST /api/push-unsubscribe<- {endpoint}        (mot de passe)
 *   POST /api/push-test                            (mot de passe) -> {sent, removed}
 *
 * Variables d'environnement (Cloudflare > projet > Paramètres > Variables et secrets) :
 *   ADMIN_PASSWORD  mot de passe de la page Gestion            (secret)
 *   GITHUB_TOKEN    clé GitHub fine-grained, dépôt seul, Contents: Read and write (secret)
 *   GITHUB_REPO     ex. "TOUTZAFER/toutzafer"   (facultatif)
 *   GITHUB_BRANCH   ex. "main"                (facultatif)
 *   PUSH_CONTACT    ex. "mailto:contact@toutzafer.re" (facultatif)
 * Liaison (Paramètres > Liaisons) : base D1 nommée « DB ».
 * La clé GitHub ne quitte jamais le serveur : la page n'envoie que le mot de passe.
 * Les coordonnées des clients restent dans la base D1, jamais dans le dépôt GitHub.
 */
const FILE = "catalogue.json";
const PHOTO_PATH = /^img\/(w\/a\d{2,4}-u\d{1,3}-(360|720)\.(webp|jpg)|og\/a\d{2,4}-u\d{1,3}\.jpg)$/; // photos 360/720 + aperçu de partage JPG
const MAX_FILES = 36, MAX_FILE_B64 = 2_000_000, MAX_CATALOGUE = 1_000_000;
const STEPS = ["appeler", "livraison", "livree", "annulee"];
const RETENTION_DAYS = 183;          // 6 mois : au-delà, les demandes non livrées sont anonymisées
const TZ_OFFSET_H = 4;               // La Réunion : UTC+4, sans heure d'été

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

function sameText(a, b) {               // comparaison à durée constante
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

async function checkPassword(request, env, needGithub = false) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(500, "Relais non configuré (ADMIN_PASSWORD manquant).");
  if (needGithub && !env.GITHUB_TOKEN) throw new HttpError(500, "Relais non configuré (GITHUB_TOKEN manquant).");
  const lock = await pwLock(request, env);   // trop d'essais ratés depuis cette connexion : bloqué 15 minutes
  if (lock && await lock.blocked()) throw new HttpError(429, "Trop d'essais de mot de passe. Réessayez dans 15 minutes.");
  if (!sameText(request.headers.get("X-Gestion-Password") || "", env.ADMIN_PASSWORD)) {
    if (lock) await lock.fail();
    await new Promise(r => setTimeout(r, 600)); // ralentit les essais au hasard
    throw new HttpError(401, "Mot de passe incorrect.");
  }
}

/* Essais de mot de passe ratés : 10 au plus par connexion (adresse IP hachée) et par quart d'heure */
async function pwLock(request, env) {
  if (!env.DB) return null;
  try {
    const D = await getDB(env);
    const salt = await kvInit(D, "salt", () => b64u(crypto.getRandomValues(new Uint8Array(16))));
    const ip = request.headers.get("CF-Connecting-IP") || "?";
    const now = Math.floor(Date.now() / 1000), k = `pw:${(await sha256hex(salt + "|" + ip)).slice(0, 24)}:${Math.floor(now / 900)}`;
    return {
      blocked: async () => ((await D.prepare("SELECT n FROM hits WHERE k = ?").bind(k).first())?.n || 0) >= 10,
      fail: () => D.prepare("INSERT INTO hits (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1").bind(k, now + 900).run()
    };
  } catch (e) { return null; } // la base ne répond pas : on ne bloque pas l'accès à la gestion
}

async function body(request, max = 200_000) {
  const t = await request.text();
  if (t.length > max) throw new HttpError(413, "Requête trop volumineuse.");
  try { return JSON.parse(t || "{}"); } catch (e) { throw new HttpError(400, "Requête illisible."); }
}

/* =====================================================================
   Catalogue dans le dépôt GitHub
   ===================================================================== */
function gh(env) {
  const repo = env.GITHUB_REPO || "TOUTZAFER/toutzafer", branch = env.GITHUB_BRANCH || "main";
  const base = (env.GITHUB_API || "https://api.github.com") + "/repos/" + repo;
  async function api(path, opt = {}) {
    const { allow404, what, ...o2 } = opt; // allow404 : renvoie null si le fichier n'existe pas
    const r = await fetch(base + path, {
      ...o2,
      headers: {
        "Accept": "application/vnd.github+json", "Authorization": "Bearer " + env.GITHUB_TOKEN,
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "toutzafer-gestion",
        ...(opt.body ? { "Content-Type": "application/json" } : {})
      }
    });
    if (r.status === 404 && allow404) return null;
    if (r.status === 409 || r.status === 422) throw new HttpError(409, what || "Le catalogue a été modifié ailleurs.");
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

async function save(env, b) {
  const { catalogue, sha, files = [], message } = b || {};
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
    const bl = await api("/git/blobs", { method: "POST", body: JSON.stringify({ content: f.data, encoding: "base64" }) });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: bl.sha });
  }
  const cat = await api("/git/blobs", { method: "POST", body: JSON.stringify({ content: textToB64(catalogue), encoding: "base64" }) });
  tree.push({ path: FILE, mode: "100644", type: "blob", sha: cat.sha });
  const t = await api("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree }) });
  const msg = String(message || "Gestion : mise à jour du catalogue").replace(/[\r\n]+/g, " ").slice(0, 300);
  const c = await api("/git/commits", { method: "POST", body: JSON.stringify({ message: msg, tree: t.sha, parents: [head] }) });
  await api(`/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: c.sha, force: false }) });
  return { sha: cat.sha };
}

/* ---------- Réglages publics : reglages.json (lu par la boutique) ---------- */
const CONFIG_FILE = "reglages.json";
// Lieu de livraison : une ville (Nord, Ouest, Sud) puis un quartier de cette ville
const PT_ID = /^[pv]-[a-z0-9-]{1,40}$/, LV_ID = /^l-[a-z0-9-]{1,30}$/;
function validConfig(c) {
  if (!c || typeof c !== "object") throw new HttpError(400, "Réglages invalides.");
  const wa = String((c.contact && c.contact.whatsapp) || "").replace(/\D/g, "");
  if (!/^\d{11,15}$/.test(wa)) throw new HttpError(400, "Numéro WhatsApp invalide (format international, ex. 262693473945).");
  if (!Array.isArray(c.villes) || !c.villes.length || c.villes.length > 40) throw new HttpError(400, "Liste des villes invalide.");
  const ids = new Set(), noms = new Set();
  const villes = c.villes.map(v => {
    const id = String(v && v.id || ""), nom = clean(v && v.nom, 60);
    if (!/^v-[a-z0-9-]{1,40}$/.test(id) || ids.has(id)) throw new HttpError(400, "Identifiant de ville invalide ou en double.");
    if (nom.length < 2 || noms.has(nom.toLowerCase())) throw new HttpError(400, "Chaque ville doit avoir un nom, différent des autres.");
    ids.add(id); noms.add(nom.toLowerCase());
    const quartiers = [...new Set((Array.isArray(v.quartiers) ? v.quartiers : []).map(q => clean(q, 60)).filter(Boolean))].slice(0, 120);
    return { id, nom, actif: v.actif !== false, quartiers };
  });
  if (!villes.some(v => v.actif)) throw new HttpError(400, "Gardez au moins une ville proposée aux clients.");
  const min = c.commande == null ? 0 : Number(c.commande.minimum);
  if (!(min >= 0 && min <= 500)) throw new HttpError(400, "Minimum de commande invalide (entre 0 et 500 €).");
  const out = { contact: { whatsapp: wa }, commande: { minimum: round2(min) }, villes };
  // messages de la barre du haut (ordinateur) : 8 au plus, 90 caractères chacun
  if (Array.isArray(c.annonces)) out.annonces = [...new Set(c.annonces.map(t => clean(t, 90)).filter(Boolean))].slice(0, 8);
  return out;
}
async function loadConfig(env) {
  const { api, branch } = gh(env);
  const j = await api(`/contents/${CONFIG_FILE}?ref=${branch}`, { allow404: true });
  return j ? { config: JSON.parse(b64ToText(j.content)), sha: j.sha } : { config: null, sha: null };
}
async function saveConfig(env, b) {
  const { api, branch } = gh(env), cfg = b && b.config;
  // une page Gestion restée ouverte avant l'ajout du minimum ne l'envoie pas : on garde celui en place
  if (cfg && typeof cfg === "object" && (cfg.commande == null || cfg.annonces == null)) { const cur = await loadConfig(env).catch(() => null);
    if (cur && cur.config && cfg.commande == null && cur.config.commande) cfg.commande = cur.config.commande;
    if (cur && cur.config && cfg.annonces == null && Array.isArray(cur.config.annonces)) cfg.annonces = cur.config.annonces; }
  const config = validConfig(cfg);
  const msg = String((b && b.message) || "Gestion : réglages de la boutique").replace(/[\r\n]+/g, " ").slice(0, 300);
  const body = { message: msg, content: textToB64(JSON.stringify(config, null, 1) + "\n"), branch };
  if (b && typeof b.sha === "string" && b.sha) body.sha = b.sha;
  const j = await api(`/contents/${CONFIG_FILE}`, { method: "PUT", body: JSON.stringify(body), what: "Les réglages ont été modifiés ailleurs : rechargez la page." });
  return { config, sha: j.content.sha };
}
async function shopConfig(request, env) {   // version publiée, lue comme la boutique la lit
  try {
    if (!env.ASSETS) return null;
    const r = await env.ASSETS.fetch(new Request(new URL("/" + CONFIG_FILE, request.url), { headers: { "Cache-Control": "no-cache" } }));
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
function findVille(conf, villeId, villeName, activeOnly) {
  const vs = conf && Array.isArray(conf.villes) ? conf.villes : [];
  const nom = String(villeName || "").split(" — ")[0].trim();       // accepte aussi « Ville — Quartier »
  return vs.find(v => (!activeOnly || v.actif !== false) && (v.id === villeId || (nom && v.nom === nom))) || null;
}
// Ville + quartier -> {pick: « Ville — Quartier », pickId: id de la ville, ville, quartier}
function placeOf(conf, src, activeOnly) {
  const villeId = /^v-[a-z0-9-]{1,40}$/.test(String(src.villeId || "")) ? src.villeId : "";
  const v = findVille(conf, villeId, src.ville || src.pick, activeOnly);
  if (!v) return null;
  let quartier = clean(src.quartier, 60);
  if (!quartier && src.pick && String(src.pick).includes(" — ")) quartier = clean(String(src.pick).split(" — ").slice(1).join(" — "), 60);
  const known = v.quartiers.find(q => q.toLowerCase() === quartier.toLowerCase());
  if (known) quartier = known;
  return { pick: quartier ? `${v.nom} — ${quartier}` : v.nom, pickId: v.id, ville: v.nom, quartier: quartier || undefined, quartierLibre: quartier && !known ? true : undefined };
}

/* =====================================================================
   Base de données D1
   ===================================================================== */
let schemaReady = false;
async function getDB(env) {
  if (!env.DB) throw new HttpError(503, "Base de données non reliée au site (liaison « DB » manquante).");
  if (!schemaReady) {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, created TEXT NOT NULL, updated TEXT NOT NULL, status TEXT NOT NULL, anon INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS orders_created ON orders (created)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, label TEXT, created TEXT NOT NULL)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS stats (day TEXT NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, k))")
    ]);
    schemaReady = true;
  }
  return env.DB;
}
async function kvGet(D, k) { const r = await D.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first(); return r ? JSON.parse(r.v) : null; }
async function kvSet(D, k, v) { await D.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run(); }
async function kvInit(D, k, make) {   // crée la valeur une seule fois, même si deux requêtes arrivent ensemble
  let v = await kvGet(D, k); if (v) return v;
  await D.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)").bind(k, JSON.stringify(await make())).run();
  return kvGet(D, k);
}

/* ---------- Petits outils ---------- */
const round2 = n => Math.round(n * 100) / 100;
const eurTxt = n => round2(n).toFixed(2).replace(".", ",") + " €";
const nowIso = () => new Date().toISOString();
const reunion = () => new Date(Date.now() + TZ_OFFSET_H * 3600e3);          // lire avec getUTC…
const reunionDay = () => reunion().toISOString().slice(0, 10);
const z2 = n => String(n).padStart(2, "0");
function clean(s, max) { return String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function normTel(t) {
  const d = String(t || "").replace(/[^\d+]/g, "");
  if (/^0\d{9}$/.test(d)) return d;
  if (/^\+262\d{9}$/.test(d)) return "0" + d.slice(4);
  if (/^262\d{9}$/.test(d)) return "0" + d.slice(3);
  if (/^\+33\d{9}$/.test(d)) return "0" + d.slice(3);
  return null;
}
function promoOn(p, day) { const r = p && p.promo; return !!(r && r.price > 0 && r.ref > r.price && (!r.from || r.from <= day) && (!r.to || day <= r.to)); }
const b64u = buf => { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(s).length / 4) * 4, "=")), c => c.charCodeAt(0));
const concat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
const utf8 = s => new TextEncoder().encode(s);
async function sha256hex(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(s)))].map(b => b.toString(16).padStart(2, "0")).join(""); }

function rowToOrder(r) { const o = JSON.parse(r.data); o.id = r.id; o.status = r.status; o.date = o.date || r.created; o.updatedAt = r.updated; if (r.anon) o.anon = true; return o; }
async function getOrder(D, id) { const r = await D.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first(); return r ? rowToOrder(r) : null; }
async function putOrder(D, o) {
  const { id, status, updatedAt, anon, ...data } = o;
  const upd = nowIso();
  await D.prepare("UPDATE orders SET status = ?, updated = ?, data = ? WHERE id = ?").bind(status, upd, JSON.stringify(data), id).run();
  return { ...o, updatedAt: upd };
}
/* Numéro de commande : TZ-0001, TZ-0002… un seul compteur pour toutes les demandes enregistrées
   (site, message collé, saisie à la main). Compteur gardé dans kv « seq », incrémenté de façon atomique. */
async function nextNumber(D) {
  const r = await D.prepare("INSERT INTO kv (k, v) VALUES ('seq', '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1 RETURNING v").first();
  return "TZ-" + String(parseInt(r.v, 10)).padStart(4, "0");
}

async function insertOrder(D, o, idBase) {
  const created = o.date || nowIso();
  for (let k = 1; k <= 20; k++) {
    const id = k === 1 ? idBase : `${idBase}-${k}`;
    const { status, ...data } = o; delete data.id;
    const r = await D.prepare("INSERT OR IGNORE INTO orders (id, created, updated, status, data) VALUES (?, ?, ?, ?, ?)").bind(id, created, created, status, JSON.stringify(data)).run();
    if (r.meta && r.meta.changes === 1) return { ...o, id, date: created, updatedAt: created };
  }
  throw new HttpError(500, "Impossible d'attribuer un numéro de demande.");
}

/* Conservation : au-delà de 6 mois, une demande qui n'a pas abouti à une vente perd nom et téléphone */
async function purge(D) {
  const cut = new Date(Date.now() - RETENTION_DAYS * 864e5).toISOString();
  const { results } = await D.prepare("SELECT * FROM orders WHERE created < ? AND status != 'livree' AND anon = 0 LIMIT 200").bind(cut).all();
  for (const r of results || []) {
    const o = JSON.parse(r.data);
    o.prenom = "Client"; o.nom = "anonymisé"; o.tel = ""; delete o.ipHint;
    await D.prepare("UPDATE orders SET anon = 1, data = ? WHERE id = ?").bind(JSON.stringify(o), r.id).run();
  }
}

/* Limite d'envois par connexion (adresse IP hachée, jamais stockée en clair) et au total */
async function rateLimit(D, request) {
  const salt = await kvInit(D, "salt", () => b64u(crypto.getRandomValues(new Uint8Array(16))));
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "?";
  const h = (await sha256hex(salt + "|" + ip)).slice(0, 24);
  const now = Math.floor(Date.now() / 1000);
  const rules = [[`ip:${h}:${Math.floor(now / 600)}`, 8, 600], [`ipj:${h}:${Math.floor(now / 86400)}`, 30, 86400], [`all:${Math.floor(now / 3600)}`, 120, 3600]];
  let over = false;
  for (const [k, max, win] of rules) {
    const r = await D.prepare("INSERT INTO hits (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n").bind(k, now + win).first();
    if (r && r.n > max) over = true;
  }
  if (Math.random() < 0.1) await D.prepare("DELETE FROM hits WHERE exp < ?").bind(now).run();
  if (over) throw new HttpError(429, "Trop de demandes envoyées depuis cette connexion. Réessayez dans quelques minutes ou écrivez-nous sur WhatsApp.");
}

/* ---------- Demande envoyée depuis la boutique ---------- */
async function shopCatalogue(request, env) {
  if (!env.ASSETS) throw new HttpError(503, "Catalogue indisponible.");
  const r = await env.ASSETS.fetch(new Request(new URL("/catalogue.json", request.url), { headers: { "Cache-Control": "no-cache" } }));
  if (!r.ok) throw new HttpError(502, "Catalogue indisponible.");
  return r.json();
}

async function newDemande(request, env, ctx) {
  const b = await body(request, 30_000);
  if (b.site) return json({ id: "TZ-" + Date.now().toString(36).toUpperCase(), ok: true }); // piège à robots : on fait comme si
  const D = await getDB(env);
  const prenom = clean(b.prenom, 60), nom = clean(b.nom, 60), tel = normTel(b.tel);
  const miss = [!prenom && "prénom", !nom && "nom", !tel && "téléphone", !b.villeId && !b.ville && !b.pick && "ville", !clean(b.quartier, 60) && !String(b.pick || "").includes(" — ") && "quartier", b.consent !== true && "accord"].filter(Boolean);
  if (miss.length) throw new HttpError(400, "À compléter : " + miss.join(", ") + ".");
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 60) throw new HttpError(400, "Panier vide ou invalide.");
  await rateLimit(D, request);

  const conf = await shopConfig(request, env);
  let place;
  if (conf && Array.isArray(conf.villes) && conf.villes.length) {
    place = placeOf(conf, b, true);
    if (!place) throw new HttpError(400, "Nous ne livrons pas (ou plus) dans cette ville : choisissez-en une autre.", { pickGone: true });
    // le client choisit uniquement parmi les quartiers proposés pour la ville
    const vq = (conf.villes.find(v => v.id === place.pickId) || {}).quartiers || [];
    if (vq.length && (!place.quartier || place.quartierLibre)) throw new HttpError(400, "Choisissez votre quartier dans la liste proposée.", { pickGone: true });
  } else {
    const v = clean(b.ville || b.pick, 60), q = clean(b.quartier, 60);
    place = { pick: q ? `${v} — ${q}` : v, ville: v, quartier: q || undefined };
  }
  const { pick, pickId } = place;
  const cat = await shopCatalogue(request, env), day = reunionDay();
  const byId = Object.fromEntries((Array.isArray(cat) ? cat : []).map(p => [p.id, p]));
  const merged = new Map(), gone = [];
  for (const l of b.lines) {
    const p = byId[String(l && l.id)], q = Math.floor(+(l && l.q));
    if (!(q >= 1 && q <= 99)) throw new HttpError(400, "Quantité invalide.");
    if (!p || p.hidden) { gone.push(String(l && l.id)); continue; }
    if (p.oos) { gone.push(p.id); continue; }
    const v = p.variants && p.variants.find(x => x.name === l.v) ? l.v : "";
    const key = p.id + "|" + v;
    const cur = merged.get(key) || { id: p.id, v, name: p.name + (v ? ` — ${v}` : ""), q: 0, price: promoOn(p, day) ? p.promo.price : p.price };
    if (promoOn(p, day)) cur.was = p.promo.ref;
    cur.q += q; merged.set(key, cur);
  }
  if (gone.length) throw new HttpError(409, "Certains articles ne sont plus disponibles.", { gone: [...new Set(gone)] });
  const lines = [...merged.values()].map(l => { if (l.q > 99) l.q = 99; return l; });
  const total = round2(lines.reduce((a, l) => a + l.q * l.price, 0));
  const minOrder = Number(conf && conf.commande && conf.commande.minimum) || 0;
  if (total + 0.004 < minOrder) throw new HttpError(400, `Il manque ${eurTxt(minOrder - total)} pour atteindre le minimum de commande de ${eurTxt(minOrder)}.`, { pickGone: true });
  const saved = round2(lines.reduce((a, l) => a + (l.was ? (l.was - l.price) * l.q : 0), 0));
  const idBase = await nextNumber(D);
  const o = await insertOrder(D, { date: nowIso(), prenom, nom, tel, ...place, lines, total, saved, shipFree: true, status: "appeler", source: "site",
    shownTotal: typeof b.total === "number" ? round2(b.total) : undefined, ...(await habitualLivreur(D, pickId)) }, idBase);

  const n = (await D.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'appeler'").first()).n;
  const nb = lines.reduce((a, l) => a + l.q, 0);
  const job = notifyAll(env, D, {
    title: `Nouvelle demande · ${eurTxt(total)}`,
    body: `${prenom} ${nom} · ${nb} article${nb > 1 ? "s" : ""}\n${pick}`,
    tag: o.id, url: "/gestion/#demandes", n
  }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return json({ ok: true, id: o.id, lines: lines.map(({ name, q, price, was }) => ({ name, q, price, was })), total, saved });
}

/* ---------- Mesure d'audience anonyme ----------
   Chaque clé est un compteur du jour (heure de La Réunion). Aucune donnée ne permet d'identifier un visiteur :
   ni cookie, ni identifiant, ni adresse IP conservée (elle sert seulement, hachée, à limiter les envois abusifs).
   Conservation : 25 mois (durée retenue par la CNIL pour les statistiques de fréquentation). */
const STAT_RULES = { visit: 0, pv: 0, cart: 0, form: 0, sent: 0, fallback: 0, promo: 0, wa: 0, src: "word", dev: "word", land: "word", view: "art", add: "art", share: "art", cat: "word", search: "term", search0: "term" };
const BOT_UA = /bot|crawl|spider|slurp|lighthouse|headless|facebookexternalhit|preview|monitor/i;
function statKey(e) {
  if (!Array.isArray(e) || typeof e[0] !== "string" || !(e[0] in STAT_RULES)) return null;
  const rule = STAT_RULES[e[0]], v = e[1];
  if (!rule) return e[0];
  if (typeof v !== "string") return null;
  if (rule === "word") return /^[a-z0-9-]{1,20}$/.test(v) ? e[0] + ":" + v : null;
  if (rule === "art") return /^a\d{2,4}$/.test(v) ? e[0] + ":" + v : null;
  const t = clean(v, 60).toLowerCase().slice(0, 40).trim();
  if (t.length < 2 || /\d{5,}|@|https?:/.test(t)) return null;          // jamais de numéro, d'e-mail ni d'adresse web
  return e[0] + ":" + t;
}
async function recordStats(request, env) {
  if (BOT_UA.test(request.headers.get("User-Agent") || "")) return new Response(null, { status: 204 });
  let b; try { b = JSON.parse((await request.text()).slice(0, 20000)); } catch (e) { return new Response(null, { status: 204 }); }
  const list = Array.isArray(b && b.e) ? b.e.slice(0, 80) : [];
  const counts = new Map();
  for (const e of list) { const k = statKey(e); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  if (!counts.size || !env.DB) return new Response(null, { status: 204 });
  const D = await getDB(env);
  const salt = await kvInit(D, "salt", () => b64u(crypto.getRandomValues(new Uint8Array(16))));
  const h = (await sha256hex(salt + "|" + (request.headers.get("CF-Connecting-IP") || "?"))).slice(0, 24), now = Math.floor(Date.now() / 1000);
  for (const [k, max, win] of [[`st:${h}:${Math.floor(now / 600)}`, 120, 600], [`stall:${Math.floor(now / 3600)}`, 20000, 3600]]) {
    const r = await D.prepare("INSERT INTO hits (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n").bind(k, now + win).first();
    if (r && r.n > max) return new Response(null, { status: 204 });
  }
  const day = reunionDay();
  await D.batch([...counts].map(([k, n]) => D.prepare("INSERT INTO stats (day, k, n) VALUES (?, ?, ?) ON CONFLICT(day, k) DO UPDATE SET n = n + excluded.n").bind(day, k, n)));
  if (Math.random() < 0.02) {
    const old = new Date(Date.now() - 760 * 864e5).toISOString().slice(0, 10);
    await D.prepare("DELETE FROM stats WHERE day < ?").bind(old).run();
  }
  return new Response(null, { status: 204 });
}
async function readStats(D, url) {
  const day = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "") ? s : null;
  const to = day(url.searchParams.get("to")) || reunionDay(), from = day(url.searchParams.get("from")) || "2000-01-01";
  const g = "CASE WHEN instr(k, ':') > 0 THEN substr(k, 1, instr(k, ':') - 1) ELSE k END";
  const [first, daily, totals] = await Promise.all([
    D.prepare("SELECT MIN(day) AS d FROM stats").first(),
    D.prepare(`SELECT day, grp, SUM(n) AS n FROM (SELECT day, ${g} AS grp, n FROM stats WHERE day BETWEEN ? AND ?) WHERE grp IN ('visit','pv','view','add','cart','form','sent') GROUP BY day, grp`).bind(from, to).all(),
    D.prepare("SELECT k, SUM(n) AS n FROM stats WHERE day BETWEEN ? AND ? GROUP BY k").bind(from, to).all()
  ]);
  const out = {};
  for (const r of daily.results || []) (out[r.day] = out[r.day] || {})[r.grp] = r.n;
  return { first: first && first.d, from, to, daily: out, totals: Object.fromEntries((totals.results || []).map(r => [r.k, r.n])) };
}

/* ---------- Demandes : page Gestion ---------- */
const PAY = ["especes", "cb"];
function checkPatch(p) {
  const out = {};
  if ("status" in p) { if (!STEPS.includes(p.status)) throw new HttpError(400, "Étape inconnue."); out.status = p.status; }
  if ("livreur" in p) out.livreur = p.livreur == null || p.livreur === "" ? null : clean(p.livreur, 40);
  if ("paiement" in p) { if (p.paiement != null && !PAY.includes(p.paiement)) throw new HttpError(400, "Mode de paiement inconnu."); out.paiement = p.paiement || null; }
  if ("cancelFrom" in p) { if (p.cancelFrom != null && !["appeler", "livraison"].includes(p.cancelFrom)) throw new HttpError(400, "Étape d'annulation inconnue."); out.cancelFrom = p.cancelFrom || null; }
  if ("cancelReason" in p) out.cancelReason = p.cancelReason == null ? null : clean(p.cancelReason, 80);
  if ("deliveredAt" in p) { if (p.deliveredAt != null && isNaN(Date.parse(p.deliveredAt))) throw new HttpError(400, "Date de livraison invalide."); out.deliveredAt = p.deliveredAt || null; }
  if ("confirmedAt" in p) { if (p.confirmedAt != null && isNaN(Date.parse(p.confirmedAt))) throw new HttpError(400, "Date invalide."); out.confirmedAt = p.confirmedAt || null; }
  if ("livreurId" in p) { if (p.livreurId != null && p.livreurId !== "" && !LV_ID.test(p.livreurId)) throw new HttpError(400, "Livreur inconnu."); out.livreurId = p.livreurId || null; }
  if ("transmisAt" in p) { if (p.transmisAt != null && isNaN(Date.parse(p.transmisAt))) throw new HttpError(400, "Date invalide."); out.transmisAt = p.transmisAt || null; }
  if ("note" in p) out.note = clean(p.note, 500) || null;
  return out;
}
function checkLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 60) throw new HttpError(400, "Ajoutez au moins un article.");
  return lines.map(l => {
    const q = Math.floor(+l.q), price = round2(+l.price), name = clean(l.name, 140);
    if (!name || !(q >= 1 && q <= 999) || !(price >= 0 && price < 100000)) throw new HttpError(400, "Ligne d'article invalide.");
    return { name, q, price };
  });
}
async function createManual(D, b, conf) {
  const s = b.order || {};
  const prenom = clean(s.prenom, 60), nom = clean(s.nom, 60), tel = normTel(s.tel) || clean(s.tel, 20);
  const place = placeOf(conf, s, false) || { pick: clean(s.pick || [s.ville, s.quartier].filter(Boolean).join(" — "), 120) || undefined };
  const pickId = place.pickId || "";
  if (!prenom || !tel) throw new HttpError(400, "Indiquez au moins le prénom et le téléphone.");
  const lines = checkLines(s.lines);
  const total = round2(lines.reduce((a, l) => a + l.q * l.price, 0));
  const ref = clean(s.id, 40).replace(/[^A-Za-z0-9-]/g, "");   // numéro écrit dans un message reçu (envoi de secours)
  const idBase = await nextNumber(D);
  return insertOrder(D, { date: nowIso(), prenom, nom, tel, ...place, lines, total, status: "appeler", source: s.id ? "message" : "manuel", ref: ref || undefined,
    canal: ["sms", "wa"].includes(s.canal) ? s.canal : undefined, ...(await habitualLivreur(D, pickId)) }, idBase);
}

/* Réglages internes (jamais publiés) :
   livreurs : [{id, prenom, tel, statut, siret, actif, note}]
   points   : {idVille: {livreurId, note}}   (le nom et les quartiers sont dans reglages.json)
   motifs   : motifs d'annulation ; modele : message de confirmation au client ("" = modèle par défaut) */
const STATUTS = ["entrepreneur", "salarie", "auto", "autre"];
const DEFAULT_MOTIFS = ["Ne souhaite plus l’article", "Injoignable", "Absent au rendez-vous", "Article indisponible", "Autre"];
const slug = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "x";
async function settingsGet(D) {
  const s = (await kvGet(D, "settings")) || {};
  const seen = new Set();
  const livreurs = (Array.isArray(s.livreurs) ? s.livreurs : []).map(x => {   // anciennes listes de prénoms -> fiches
    const o = typeof x === "string" ? { id: "l-" + slug(x), prenom: x, actif: true } : x;
    let id = o.id; for (let k = 2; seen.has(id); k++) id = o.id + "-" + k; seen.add(id);
    return { ...o, id };
  });
  return { livreurs, points: s.points && typeof s.points === "object" ? s.points : {}, motifs: Array.isArray(s.motifs) && s.motifs.length ? s.motifs : DEFAULT_MOTIFS, modele: typeof s.modele === "string" ? s.modele : "" };
}
async function settingsSet(D, b) {
  const s = await settingsGet(D);
  if ("livreurs" in b) {
    if (!Array.isArray(b.livreurs) || b.livreurs.length > 50) throw new HttpError(400, "Liste de livreurs invalide.");
    const ids = new Set();
    s.livreurs = b.livreurs.map(l => {
      const id = String(l && l.id || ""), prenom = clean(l && l.prenom, 40);
      if (!LV_ID.test(id) || ids.has(id) || !prenom) throw new HttpError(400, "Fiche livreur invalide (prénom manquant ?).");
      ids.add(id);
      const o = { id, prenom, actif: l.actif !== false }; if (STATUTS.includes(l.statut)) o.statut = l.statut;
      const tel = normTel(l.tel) || clean(l.tel, 20); if (tel) o.tel = tel;
      const siret = String(l.siret || "").replace(/\D/g, "").slice(0, 14); if (siret) o.siret = siret;
      const note = clean(l.note, 500); if (note) o.note = note;
      return o;
    });
  }
  if ("points" in b) {
    if (!b.points || typeof b.points !== "object" || Array.isArray(b.points)) throw new HttpError(400, "Fiches des points invalides.");
    const out = {};
    for (const [id, v] of Object.entries(b.points).slice(0, 60)) {
      if (!PT_ID.test(id) || !v || typeof v !== "object") continue;
      const o = {}; if (LV_ID.test(String(v.livreurId || ""))) o.livreurId = v.livreurId;
      const note = clean(v.note, 500); if (note) o.note = note;
      if (Object.keys(o).length) out[id] = o;
    }
    s.points = out;
  }
  if ("motifs" in b) {
    const m = Array.isArray(b.motifs) ? [...new Set(b.motifs.map(x => clean(x, 60)).filter(Boolean))].slice(0, 15) : [];
    if (!m.length) throw new HttpError(400, "Gardez au moins un motif d'annulation.");
    s.motifs = m;
  }
  if ("modele" in b) s.modele = String(b.modele || "").replace(/\r/g, "").slice(0, 2000);
  await kvSet(D, "settings", s); return s;
}
async function habitualLivreur(D, pickId) {   // livreur habituel de la ville : attribué d'office, modifiable ensuite
  if (!pickId) return {};
  const s = await settingsGet(D), v = s.points[pickId], l = v && s.livreurs.find(x => x.id === v.livreurId && x.actif !== false);
  return l ? { livreurId: l.id, livreur: l.prenom } : {};
}

/* =====================================================================
   Notifications Web Push (RFC 8030 / 8291 / 8292), sans bibliothèque
   ===================================================================== */
async function vapidKeys(D) {
  return kvInit(D, "vapid", async () => {
    const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return { pub: b64u(await crypto.subtle.exportKey("raw", k.publicKey)), jwk: await crypto.subtle.exportKey("jwk", k.privateKey) };
  });
}
async function vapidHeader(env, keys, endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(utf8(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.PUSH_CONTACT || "mailto:contact@toutzafer.re" })));
  const key = await crypto.subtle.importKey("jwk", keys.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(head + "." + claims)); // r||s (64 octets)
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.pub}`;
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
async function encryptPayload(sub, text) {          // chiffrement « aes128gcm » (RFC 8291)
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(utf8("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(utf8(text), new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function sendPush(env, keys, sub, payload) {
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { "TTL": "86400", "Urgency": "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      "Authorization": await vapidHeader(env, keys, sub.endpoint) },
    body: await encryptPayload(sub, JSON.stringify(payload))
  });
  return r.status;
}
async function notifyAll(env, D, payload) {
  const { results } = await D.prepare("SELECT endpoint, sub FROM push_subs").all();
  if (!results || !results.length) return { sent: 0, removed: 0 };
  const keys = await vapidKeys(D);
  let sent = 0, removed = 0;
  await Promise.all(results.map(async r => {
    try {
      const st = await sendPush(env, keys, JSON.parse(r.sub), payload);
      if (st === 404 || st === 410) { await D.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(r.endpoint).run(); removed++; }
      else if (st >= 200 && st < 300) sent++;
    } catch (e) { /* un appareil injoignable ne bloque pas les autres */ }
  }));
  return { sent, removed };
}
function checkSub(s) {
  const ok = s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1200 && s.keys
    && /^[A-Za-z0-9_-]{80,100}$/.test(s.keys.p256dh || "") && /^[A-Za-z0-9_-]{16,32}$/.test(s.keys.auth || "");
  if (!ok) throw new HttpError(400, "Abonnement aux notifications invalide.");
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

/* =====================================================================
   Aiguillage
   ===================================================================== */
export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  const route = [].concat(params.path || []).join("/"), M = request.method;
  try {
    if (route === "ping" && M === "GET") return json({ ok: true, db: !!env.DB });

    // Catalogue
    if (route === "catalogue" && M === "GET") { await checkPassword(request, env, true); return json(await load(env)); }
    if (route === "save" && M === "POST") { await checkPassword(request, env, true); return json(await save(env, await body(request, 60_000_000))); }

    // Demande d'un client (public)
    if (route === "demande" && M === "POST") return await newDemande(request, env, ctx);
    if (route === "stat" && M === "POST") return await recordStats(request, env);
    if (route === "push-key" && M === "GET") { const D = await getDB(env); return json({ key: (await vapidKeys(D)).pub }); }

    // Page Gestion
    if (route === "config" && M === "GET") { await checkPassword(request, env, true); return json(await loadConfig(env)); }
    if (route === "config" && M === "POST") { await checkPassword(request, env, true); return json(await saveConfig(env, await body(request))); }

    const admin = { "GET orders": 1, "POST order-update": 1, "POST order-create": 1, "POST order-delete": 1, "GET settings": 1, "POST settings": 1,
      "POST push-subscribe": 1, "POST push-unsubscribe": 1, "POST push-test": 1, "GET stats": 1 };
    if (!admin[M + " " + route]) return json({ error: "Introuvable" }, 404);
    await checkPassword(request, env);
    const D = await getDB(env);
    if (route === "orders") {
      await purge(D);
      const { results } = await D.prepare("SELECT * FROM orders ORDER BY created DESC LIMIT 3000").all();
      return json({ orders: (results || []).map(rowToOrder), now: nowIso() });
    }
    if (route === "stats") return json(await readStats(D, new URL(request.url)));
    const b = await body(request);
    if (route === "order-update") {
      const o = await getOrder(D, String(b.id || ""));
      if (!o) throw new HttpError(404, "Demande introuvable (supprimée ?).");
      const patch = checkPatch(b.patch || {});
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete o[k]; else o[k] = v; }
      return json({ order: await putOrder(D, o) });
    }
    if (route === "order-create") return json({ order: await createManual(D, b, await shopConfig(request, env)) });
    if (route === "order-delete") { await D.prepare("DELETE FROM orders WHERE id = ?").bind(String(b.id || "")).run(); return json({ ok: true }); }
    if (route === "settings") return json(M === "GET" ? await settingsGet(D) : await settingsSet(D, b));
    if (route === "push-subscribe") {
      const s = checkSub(b.sub);
      await D.prepare("INSERT INTO push_subs (endpoint, sub, label, created) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub, label = excluded.label")
        .bind(s.endpoint, JSON.stringify(s), clean(b.label, 60) || null, nowIso()).run();
      const n = (await D.prepare("SELECT COUNT(*) AS n FROM push_subs").first()).n;
      return json({ ok: true, devices: n });
    }
    if (route === "push-unsubscribe") { await D.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(String(b.endpoint || "")).run(); return json({ ok: true }); }
    if (route === "push-test") {
      const n = (await D.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'appeler'").first()).n;
      return json(await notifyAll(env, D, { title: "Notifications activées", body: "Vous serez prévenu ici à chaque nouvelle demande.", tag: "test", url: "/gestion/#demandes", n }));
    }
    return json({ error: "Introuvable" }, 404);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e.message || "Erreur interne", ...(e.extra || {}) }, status);
  }
}
