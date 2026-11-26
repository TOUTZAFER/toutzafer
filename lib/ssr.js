/* Tout'zafer · contenu de la boutique écrit côté serveur (pour Google et les navigateurs sans JavaScript)
 *
 * Utilisé par functions/index.js (accueil) et functions/article/[[path]].js (page d'un article).
 * - grille des articles en vrais liens <a href="/article/..."> (la boutique la remplace dès que le catalogue est chargé) ;
 * - page d'un article : fiche écrite dans #sheet (nom en titre, photos, prix, description, caractéristiques),
 *   la boutique l'ouvre ensuite par-dessus le catalogue comme d'habitude.
 * Règles (adresses, promotions, photos) identiques à index.html.
 */
export const SITE = "https://toutzafer.re";

/* Adresse unique : www.toutzafer.re et toutzafer.pages.dev renvoient (301) vers https://toutzafer.re,
   chemin et paramètres conservés. Les aperçus (xxx.toutzafer.pages.dev) ne sont pas redirigés. */
const OTHER_HOSTS = new Set(["www.toutzafer.re", "toutzafer.pages.dev"]);
export function toCanonical(request) {
  const u = new URL(request.url);
  if (!OTHER_HOSTS.has(u.hostname)) return null;
  return Response.redirect(SITE + u.pathname + u.search, 301);
}
const TZ_OFFSET_H = 4;
export const CATS = [["cuisine", "Cuisine"], ["rangement", "Rangement"], ["maison", "Maison"], ["enfants", "Bébé & enfants"], ["animaux", "Animaux"]];
export const CATNAME = Object.fromEntries(CATS);

export const slugify = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
export const articlePath = p => `/article/${p.id}-${slugify(p.name)}`;
export const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const eur = n => (Math.round(n * 100) / 100).toFixed(2).replace(".", ",") + " €";
export const day = () => new Date(Date.now() + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
export function promoOn(p, d = day()) { const r = p.promo; return !!(r && r.price > 0 && r.ref > r.price && (!r.from || r.from <= d) && (!r.to || d <= r.to)); }
export function photo(b, size) { const m = String(b).match(/^(.*)\.(webp|jpg|png)$/); return m ? `/img/w/${m[1]}-${size}.${m[2]}` : `/img/w/${b}-${size}.webp`; }
export const visible = cat => (Array.isArray(cat) ? cat : []).filter(p => !p.hidden && p.base && p.base.length);
export const priceOf = (p, d = day()) => promoOn(p, d) ? p.promo.price : p.price;

const priceHTML = v => { const [e, c] = v.toFixed(2).split("."); return `<span class="pr"><b>${e}</b><span>,${c} €</span></span>`; };
const SZ_CARD = "(max-width:640px) 46vw, (max-width:900px) 31vw, 260px";
const img = (b, attrs, sizes = SZ_CARD) => `<img src="${photo(b, 720)}" srcset="${photo(b, 360)} 360w, ${photo(b, 720)} 720w" sizes="${sizes}" ${attrs}>`;

/* Grille des articles, groupée par catégorie, ruptures en fin de catégorie (comme la boutique) */
export function gridHTML(cat) {
  const d = day(), list = visible(cat).slice().sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const order = CATS.map(c => c[0]);
  list.sort((a, b) => (order.indexOf(a.cat) - order.indexOf(b.cat)) || (!!a.oos - !!b.oos));
  let prev = null;
  return list.map(p => {
    let head = "";
    if (p.cat !== prev) { prev = p.cat; head = `<h2 class="ghead" id="g-${esc(p.cat)}" data-cat="${esc(p.cat)}">${esc(CATNAME[p.cat] || p.cat)}<span class="tabnum">${list.filter(x => x.cat === p.cat).length}</span></h2>`; }
    const promo = promoOn(p, d), price = promo ? p.promo.price : p.price, href = articlePath(p);
    return head + `<article class="card${p.oos ? " out" : ""}" data-id="${esc(p.id)}"><div class="media"><a class="thumb" href="${esc(href)}" data-open="${esc(p.id)}" aria-label="Voir ${esc(p.name)}">${p.oos ? '<span class="badge">En rupture</span>' : promo ? '<span class="pastille">PROMO</span>' : ""}${img(p.base[0], `alt="${esc(p.name)}" loading="lazy" width="720" height="720"`)}</a></div><div class="meta"><a class="name" href="${esc(href)}" data-open="${esc(p.id)}">${esc(p.name)}</a><span class="price${promo ? " promo" : ""}">${priceHTML(price)}${promo ? `<s class="was">${eur(p.promo.ref)}</s>` : ""}</span></div></article>`;
  }).join("");
}

/* Fiche d'un article écrite dans #sheet (cachée tant que la boutique ne l'ouvre pas) */
export function sheetHTML(p) {
  const d = day(), promo = promoOn(p, d), price = promo ? p.promo.price : p.price, n = p.base.length;
  const photos = p.base.map((b, i) => img(b, `alt="${esc(p.name)}, photo ${i + 1} sur ${n}"${i ? ' loading="lazy"' : ""} width="720" height="720"`, "(max-width:700px) 100vw, 480px")).join("");
  return `<div class="gal"><div class="stage"><div class="track">${photos}</div></div></div><div class="info"><span class="cat">${esc(CATNAME[p.cat] || "")}</span><h1 id="sTitle">${esc(p.name)}</h1><div class="buyrow"><span class="big${promo ? " promo" : ""}">${priceHTML(price)}${promo ? ` <s class="was">${eur(p.promo.ref)}</s>` : ""}</span></div>${p.oos ? "<p><b>En rupture</b>, bientôt de retour.</p>" : ""}${p.d ? `<p class="d">${esc(p.d)}</p>` : ""}${p.desc ? `<p>${esc(p.desc)}</p>` : ""}${(p.specs || []).length ? `<ul>${p.specs.map(s => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}<p>Livraison offerte dans le Nord, l’Ouest et le Sud de La Réunion. Paiement à la livraison, en espèces ou par carte.</p><p><a href="/">Voir tous les articles</a></p></div>`;
}

const SHEET = '<section class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sTitle" aria-hidden="true"></section>';
/* Insère la grille (et la fiche) dans la page de la boutique */
export function fill(page, cat, p) {
  let html = page.replace('<section class="grid" id="grid" aria-live="polite"></section>', `<section class="grid" id="grid" aria-live="polite" data-ssr="1">${gridHTML(cat)}</section>`);
  // page d'un article : un seul titre principal, le nom de l'article (le slogan de l'accueil redevient un paragraphe)
  if (p) html = html.replace(/<h1 class="lead">([^<]*)<\/h1>/, '<p class="lead">$1</p>');
  if (p) html = html.replace(SHEET, SHEET.replace("></section>", `>${sheetHTML(p)}</section>`));
  return html;
}

export async function loadPage(env, url) {
  const [page, cat] = await Promise.all([
    env.ASSETS.fetch(new Request(new URL("/", url))).then(r => r.text()),
    env.ASSETS.fetch(new Request(new URL("/catalogue.json", url))).then(r => r.ok ? r.json() : []).catch(() => [])
  ]);
  return { page, cat: Array.isArray(cat) ? cat : [] };
}
