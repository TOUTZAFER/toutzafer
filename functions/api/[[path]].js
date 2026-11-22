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
 *   GET  /api/settings        -> {livreurs:[...]}  ·  POST /api/settings <- {livreurs:[...]}
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
const PHOTO_PATH = /^img\/w\/a\d{2,4}-u\d{1,3}-(360|720)\.(webp|jpg)$/;
const MAX_FILES = 24, MAX_FILE_B64 = 2_000_000, MAX_CATALOGUE = 1_000_000;
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
  if (!sameText(request.headers.get("X-Gestion-Password") || "", env.ADMIN_PASSWORD)) {
    await new Promise(r => setTimeout(r, 600)); // ralentit les essais au hasard
    throw new HttpError(401, "Mot de passe incorrect.");
  }
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
      env.DB.prepare("CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)")
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
  const prenom = clean(b.prenom, 60), nom = clean(b.nom, 60), tel = normTel(b.tel), pick = clean(b.pick, 120);
  const miss = [!prenom && "prénom", !nom && "nom", !tel && "téléphone", !pick && "point de livraison", b.consent !== true && "accord"].filter(Boolean);
  if (miss.length) throw new HttpError(400, "À compléter : " + miss.join(", ") + ".");
  if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 60) throw new HttpError(400, "Panier vide ou invalide.");
  await rateLimit(D, request);

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
  const saved = round2(lines.reduce((a, l) => a + (l.was ? (l.was - l.price) * l.q : 0), 0));
  const r = reunion();
  const idBase = `TZ-${z2(r.getUTCDate())}${z2(r.getUTCMonth() + 1)}${String(r.getUTCFullYear()).slice(2)}-${z2(r.getUTCHours())}${z2(r.getUTCMinutes())}${z2(r.getUTCSeconds())}`;
  const o = await insertOrder(D, { date: nowIso(), prenom, nom, tel, pick, lines, total, saved, shipFree: true, status: "appeler", source: "site",
    shownTotal: typeof b.total === "number" ? round2(b.total) : undefined }, idBase);

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
async function createManual(D, b) {
  const s = b.order || {};
  const prenom = clean(s.prenom, 60), nom = clean(s.nom, 60), tel = normTel(s.tel) || clean(s.tel, 20), pick = clean(s.pick, 120);
  if (!prenom || !tel) throw new HttpError(400, "Indiquez au moins le prénom et le téléphone.");
  const lines = checkLines(s.lines);
  const total = round2(lines.reduce((a, l) => a + l.q * l.price, 0));
  let idBase = clean(s.id, 40).replace(/[^A-Za-z0-9-]/g, "");
  if (!idBase) { const r = reunion(); idBase = `M-${z2(r.getUTCDate())}${z2(r.getUTCMonth() + 1)}${String(r.getUTCFullYear()).slice(2)}-${z2(r.getUTCHours())}${z2(r.getUTCMinutes())}${z2(r.getUTCSeconds())}`; }
  return insertOrder(D, { date: nowIso(), prenom, nom, tel, pick, lines, total, status: "appeler", source: s.id ? "message" : "manuel", canal: ["sms", "wa"].includes(s.canal) ? s.canal : undefined }, idBase);
}

async function settingsGet(D) { return (await kvGet(D, "settings")) || { livreurs: [] }; }
async function settingsSet(D, b) {
  const L = Array.isArray(b.livreurs) ? [...new Set(b.livreurs.map(x => clean(x, 40)).filter(Boolean))].slice(0, 30) : null;
  if (!L) throw new HttpError(400, "Liste de livreurs invalide.");
  const s = { ...(await settingsGet(D)), livreurs: L }; await kvSet(D, "settings", s); return s;
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
    if (route === "push-key" && M === "GET") { const D = await getDB(env); return json({ key: (await vapidKeys(D)).pub }); }

    // Page Gestion
    const admin = { "GET orders": 1, "POST order-update": 1, "POST order-create": 1, "POST order-delete": 1, "GET settings": 1, "POST settings": 1,
      "POST push-subscribe": 1, "POST push-unsubscribe": 1, "POST push-test": 1 };
    if (!admin[M + " " + route]) return json({ error: "Introuvable" }, 404);
    await checkPassword(request, env);
    const D = await getDB(env);
    if (route === "orders") {
      await purge(D);
      const { results } = await D.prepare("SELECT * FROM orders ORDER BY created DESC LIMIT 3000").all();
      return json({ orders: (results || []).map(rowToOrder), now: nowIso() });
    }
    const b = await body(request);
    if (route === "order-update") {
      const o = await getOrder(D, String(b.id || ""));
      if (!o) throw new HttpError(404, "Demande introuvable (supprimée ?).");
      const patch = checkPatch(b.patch || {});
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete o[k]; else o[k] = v; }
      return json({ order: await putOrder(D, o) });
    }
    if (route === "order-create") return json({ order: await createManual(D, b) });
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
