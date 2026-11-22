/* Tout'zafer · page d'un article : /article/<id>-<nom>
 *
 * Renvoie la boutique (index.html) avec, dans l'en-tête, les informations de l'article :
 * titre, description, adresse canonique, aperçu de partage (WhatsApp, Facebook) et données
 * produit pour Google (prix TTC, disponibilité, livraison offerte, retour sous 14 jours).
 * La boutique ouvre ensuite la fiche de l'article par-dessus le catalogue.
 * - nom modifié depuis Gestion : l'ancienne adresse redirige (301) vers la nouvelle ;
 * - article inconnu ou masqué : boutique avec statut 404 et « noindex ».
 * Règle des adresses identique à slugify() dans index.html.
 */
const SITE = "https://toutzafer.re";
const TZ_OFFSET_H = 4;
const CATNAME = { cuisine: "Cuisine", rangement: "Rangement", maison: "Maison", enfants: "Bébé & enfants", animaux: "Animaux" };

const slugify = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
const articlePath = p => `/article/${p.id}-${slugify(p.name)}`;
const attr = s => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const eur = n => (Math.round(n * 100) / 100).toFixed(2).replace(".", ",") + " €";
const day = () => new Date(Date.now() + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
function promoOn(p, d) { const r = p.promo; return !!(r && r.price > 0 && r.ref > r.price && (!r.from || r.from <= d) && (!r.to || d <= r.to)); }
function photo(b, size) { const m = String(b).match(/^(.*)\.(webp|jpg|png)$/); return m ? `/img/w/${m[1]}-${size}.${m[2]}` : `/img/w/${b}-${size}.webp`; }
const stem = b => String(b).replace(/\.(webp|jpg|png)$/, "");
function cut(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; }

function headFor(p, ogImage) {
  const d = day(), promo = promoOn(p, d), price = promo ? p.promo.price : p.price, url = SITE + articlePath(p);
  const title = `${p.name} à ${eur(price)} · Tout’zafer La Réunion`;
  const desc = cut(`${p.d ? p.d + ". " : ""}${p.desc || ""}`, 120) + (p.oos ? " Bientôt de retour." : ` ${eur(price)}, livraison offerte, paiement à la livraison.`);
  const imgs = (p.base || []).slice(0, 6).map(b => SITE + photo(b, 720));
  const offer = {
    "@type": "Offer", url, priceCurrency: "EUR", price: price.toFixed(2),
    availability: p.oos ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
    itemCondition: "https://schema.org/NewCondition",
    seller: { "@type": "Organization", name: "Tout’zafer" },
    shippingDetails: { "@type": "OfferShippingDetails", shippingRate: { "@type": "MonetaryAmount", value: "0", currency: "EUR" },
      shippingDestination: { "@type": "DefinedRegion", addressCountry: "RE" } },
    hasMerchantReturnPolicy: { "@type": "MerchantReturnPolicy", applicableCountry: "RE", returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
      merchantReturnDays: 14, returnFees: "https://schema.org/FreeReturn" }
  };
  if (promo && p.promo.to) offer.priceValidUntil = p.promo.to;
  const ld = { "@context": "https://schema.org", "@type": "Product", name: p.name, sku: p.id, image: imgs, description: cut(p.desc || p.d || p.name, 500),
    category: CATNAME[p.cat] || undefined, offers: offer };
  return `<title>${attr(title)}</title>
<meta name="description" content="${attr(desc)}">
<link rel="canonical" href="${attr(url)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Tout’zafer">
<meta property="og:locale" content="fr_FR">
<meta property="og:title" content="${attr(`${p.name} · ${eur(price)}${promo ? ` au lieu de ${eur(p.promo.ref)}` : ""}`)}">
<meta property="og:description" content="${attr(desc)}">
<meta property="og:url" content="${attr(url)}">
<meta property="og:image" content="${attr(ogImage)}">
<meta property="og:image:alt" content="${attr(p.name)}">
<meta property="product:price:amount" content="${price.toFixed(2)}">
<meta property="product:price:currency" content="EUR">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;
}

export async function onRequest({ request, env, params }) {
  const url = new URL(request.url);
  const seg = [].concat(params.path || []).join("/");
  const m = seg.match(/^(a\d{2,4})(?:-|$)/);
  if (!m) return Response.redirect(new URL("/", url).toString(), 302);
  const [page, cat] = await Promise.all([
    env.ASSETS.fetch(new Request(new URL("/", url))).then(r => r.text()),
    env.ASSETS.fetch(new Request(new URL("/catalogue.json", url))).then(r => r.ok ? r.json() : []).catch(() => [])
  ]);
  const p = (Array.isArray(cat) ? cat : []).find(x => x.id === m[1] && !x.hidden && x.base && x.base.length);
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" };
  if (!p) {
    const html = page.replace(/<!--meta-->[\s\S]*?<!--\/meta-->/, `<title>Article introuvable · Tout’zafer</title>\n<meta name="robots" content="noindex">`);
    return new Response(html, { status: 404, headers });
  }
  const canon = articlePath(p);
  if (decodeURIComponent(url.pathname) !== canon) return Response.redirect(new URL(canon, url).toString(), 301);
  // aperçu de partage : JPG (lu partout) s'il existe, sinon la photo 720 px
  const og = `/img/og/${stem(p.base[0])}.jpg`;
  const hasJpg = await env.ASSETS.fetch(new Request(new URL(og, url), { method: "HEAD" })).then(r => r.ok && /image/.test(r.headers.get("Content-Type") || "")).catch(() => false);
  const html = page.replace(/<!--meta-->[\s\S]*?<!--\/meta-->/, headFor(p, SITE + (hasJpg ? og : photo(p.base[0], 720))));
  return new Response(html, { status: 200, headers });
}
