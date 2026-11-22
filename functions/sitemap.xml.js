/* Tout'zafer · plan du site pour Google : accueil + une adresse par article visible.
   Mis à jour tout seul à partir de catalogue.json. Règle des adresses identique à index.html. */
const SITE = "https://toutzafer.re";
const slugify = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
const xml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function onRequest({ request, env }) {
  const cat = await env.ASSETS.fetch(new Request(new URL("/catalogue.json", request.url))).then(r => r.ok ? r.json() : []).catch(() => []);
  const urls = [`${SITE}/`, ...(Array.isArray(cat) ? cat : []).filter(p => !p.hidden && p.base && p.base.length)
    .map(p => `${SITE}/article/${p.id}-${slugify(p.name)}`)];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${xml(u)}</loc></url>`).join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "max-age=3600" } });
}
