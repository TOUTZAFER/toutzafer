/* Tout'zafer · accueil (/) : la boutique avec la grille des articles déjà écrite en liens,
   pour Google et les aperçus sans JavaScript. La boutique la remplace dès que le catalogue est chargé. */
import { loadPage, fill } from "../lib/ssr.js";

export async function onRequestGet({ request, env }) {
  try {
    const { page, cat } = await loadPage(env, request.url);
    return new Response(fill(page, cat), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  } catch (e) {
    return env.ASSETS.fetch(request); // en cas de souci : la page telle quelle
  }
}
