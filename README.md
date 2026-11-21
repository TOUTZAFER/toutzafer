# Tout'zafer : boutique et gestion des articles

Site de réservation de Tout'zafer (articles du quotidien, La Réunion).
Le client compose son panier et envoie sa demande par WhatsApp ou SMS ; paiement à la livraison.

## Contenu
- `index.html` : la boutique (partie client uniquement). Elle lit le catalogue dans `catalogue.json`.
- `catalogue.json` : la liste des articles (nom, prix, catégorie, description, caractéristiques, photos, rupture, masqué).
- `img/w/` : photos des articles en 360 et 720 px (`aNN-nK` : catalogue d'origine ; `aNN-uK` : ajoutées depuis la gestion).
- `gestion/` : page de gestion des articles (nouvel article, modification, rupture / retour en stock, masquer, supprimer).

## Comment la gestion met le site à jour
La page `gestion/` enregistre `catalogue.json` et les nouvelles photos dans ce dépôt (un commit par enregistrement).
L'hébergeur republie alors le site automatiquement (environ 1 minute).

- **Simulation (GitHub Pages)** : la page écrit directement dans le dépôt avec une clé GitHub « fine-grained »
  limitée à ce dépôt (droit *Contents : Read and write*), saisie une fois et gardée sur l'appareil.
- **Version finale (Cloudflare Pages)** : une petite fonction `/api` garde la clé GitHub côté serveur ;
  l'entrepreneur se connecte avec un simple mot de passe.

## Hébergement
- Boutique : https://toutzafer.pages.dev (Cloudflare Pages, projet « toutzafer », branche main, sans commande de build).
- Gestion : https://toutzafer.pages.dev/gestion/
- Secrets du projet Cloudflare (Paramètres → Variables et secrets, Production) : `ADMIN_PASSWORD`, `GITHUB_TOKEN`.
  Après modification d'un secret, relancer un déploiement.

## Vidéo de démonstration
`media/Toutzafer_demo.mp4`
