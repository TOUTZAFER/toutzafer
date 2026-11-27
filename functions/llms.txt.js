/* Tout'zafer · /llms.txt : résumé du site pour les assistants IA (ChatGPT, Claude, Perplexity, Google…).
   Généré à chaque demande à partir de reglages.json (villes, minimum, numéro) et du catalogue : toujours à jour. */
import { SITE, CATS, CATNAME, catPath, visible, toCanonical, edgeCached } from "../lib/ssr.js";

const eur = n => n.toFixed(2).replace(".", ",") + " €";
const tel = wa => { const d = String(wa || "").replace(/^262/, "0"); return d.length === 10 ? d.replace(/(\d{4})(\d{2})(\d{2})(\d{2})/, "$1 $2 $3 $4") : d; };

export async function onRequestGet(context) {
  const { request, env } = context;
  const go = toCanonical(request); if (go) return go;
  return edgeCached(context, async () => {
    const get = p => env.ASSETS.fetch(new Request(new URL(p, request.url))).then(r => r.ok ? r.json() : null).catch(() => null);
    const [conf, cat] = await Promise.all([get("/reglages.json"), get("/catalogue.json")]);
    const villes = ((conf && conf.villes) || []).filter(v => v && v.actif !== false).map(v => v.nom);
    const min = Number(conf && conf.commande && conf.commande.minimum) || 0;
    const list = visible(cat || []);
    const cats = CATS.map(([k]) => [k, list.filter(p => p.cat === k).length]).filter(([, n]) => n);
    const txt = `# Tout’zafer

> Boutique en ligne d’articles du quotidien à petit prix (cuisine, rangement, maison, bébé et enfants, animaux) à La Réunion. Livraison offerte à domicile ou dans le quartier du client, paiement à la livraison en espèces ou par carte bancaire. Aucun paiement en ligne.

## Comment commander
- Le client ajoute des articles au panier sur ${SITE}, puis envoie une demande avec son prénom, son nom, son téléphone, sa ville et son quartier.
- La demande est sans engagement et sans paiement. Tout’zafer rappelle le client pour confirmer la disponibilité, le prix et le lieu de livraison : la vente est conclue à cette confirmation.
- Le livreur contacte ensuite le client pour convenir du lieu exact, du jour et de l’heure, en général dans les 48 heures.
- Le client paie à la remise des articles, en espèces ou par carte bancaire. Il peut annuler sans frais jusqu’à la livraison.${min > 0 ? `\n- Montant minimum de commande : ${eur(min)}. La livraison est offerte.` : "\n- La livraison est offerte."}
- Droit de rétractation de 14 jours après réception, avec reprise gratuite de l’article.

## Zone de livraison
Villes desservies actuellement : ${villes.length ? villes.join(", ") : "Nord, Ouest et Sud de l’île"}. La liste exacte des villes et des quartiers est proposée dans le formulaire de commande.

## Catalogue (${list.length} articles)
${cats.map(([k, n]) => `- [${CATNAME[k]}](${SITE}${catPath(k)}) : ${n} article${n > 1 ? "s" : ""}`).join("\n")}
- Chaque article a sa propre page (prix, photos, description, disponibilité) : ${SITE}/article/<identifiant>-<nom>, toutes listées dans ${SITE}/sitemap.xml

## Contact
- WhatsApp et téléphone : ${tel(conf && conf.contact && conf.contact.whatsapp)}
- E-mail : contact@toutzafer.re

## Informations légales
- [Conditions générales de vente](${SITE}/#cgv)
- [Mentions légales](${SITE}/#mentions-legales)
`;
    return new Response(txt, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  });
}
