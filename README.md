# Tout'zafer : boutique, demandes et gestion

Site de réservation de Tout'zafer (articles du quotidien, La Réunion).
Le client compose son panier et appuie sur « Envoyer ma demande » : la demande arrive dans la page Gestion
et l'entrepreneur reçoit une notification. Il rappelle le client, confirme par écrit, livre ; paiement à la livraison.
Si l'envoi échoue, le client peut transmettre la même demande sur WhatsApp ou par SMS (message déjà rédigé).

## Contenu
- `index.html` : la boutique (partie client uniquement). Elle lit le catalogue dans `catalogue.json`.
- `reglages.json` : réglages publics lus par la boutique (numéro WhatsApp, points de livraison) ; modifié depuis Gestion → Réglages.
- `catalogue.json` : la liste des articles (nom, prix, promo, catégorie, description, caractéristiques, photos, rupture, masqué).
- `img/w/` : photos des articles en 360 et 720 px (`aNN-nK` : catalogue d'origine ; `aNN-uK` : ajoutées depuis la gestion).
- `gestion/` : page de gestion, installable sur l'écran d'accueil du téléphone :
  - **Demandes** : colonnes À appeler / En livraison / Livrée / Annulée, livreur, paiement espèces ou CB,
    confirmation écrite au client (WhatsApp ou SMS), demandes collées depuis un message ou saisies à la main ;
  - **Articles** : nouvel article, modification, promotion, rupture / retour en stock, masquer, supprimer ;
  - **Synthèse** : chiffre d'affaires livré par paiement, livreur, article et mois ; annulations ;
  - **Réglages** : fiches des points de livraison (nom, consigne, livreur habituel, note interne, pause, ordre) et des
    livreurs (téléphone, statut, SIRET, note, chiffres), motifs d'annulation, message de confirmation, numéro WhatsApp,
    notifications sur l'appareil.
- `gestion/sw.js`, `gestion/manifest.webmanifest` : notifications et installation de la page Gestion.
- `functions/api/[[path]].js` : les fonctions serveur (Cloudflare Pages Functions), voir l'en-tête du fichier.

## Où sont les données
- **Catalogue et photos** : dans ce dépôt GitHub. La page Gestion les enregistre via la fonction `/api/save`
  (la clé GitHub reste côté serveur) ; Cloudflare republie le site en 1 à 2 minutes.
- **Demandes des clients, fiches livreurs, notes internes des points, abonnements aux notifications** : dans la base Cloudflare D1 liée au projet
  sous le nom `DB`. Les tables sont créées automatiquement au premier appel. Aucune donnée client dans GitHub.
- Conservation : une demande non livrée perd nom et téléphone 6 mois après sa réception (montant et articles gardés
  pour la synthèse). Les ventes livrées sont conservées.
- Protection de l'envoi public : prix recalculés côté serveur depuis `catalogue.json`, articles en rupture refusés,
  champ piège anti-robots, limite d'envois par connexion (adresse IP hachée, jamais stockée en clair).

## Hébergement (Cloudflare Pages, projet « toutzafer », branche main, sans commande de build)
- Boutique : https://toutzafer.re · Gestion : https://toutzafer.re/gestion/
- Secrets (Paramètres → Variables et secrets, Production) : `ADMIN_PASSWORD`, `GITHUB_TOKEN`.
- Liaison (Paramètres → Liaisons) : base D1 `toutzafer` liée sous le nom **`DB`**.
- Après modification d'un secret ou d'une liaison, relancer un déploiement.
- Notifications : clés VAPID générées automatiquement et gardées dans la base. Sur iPhone (iOS 16.4 ou plus),
  ajouter la page Gestion à l'écran d'accueil puis activer les notifications depuis l'icône.

## Vidéo de démonstration
`media/Toutzafer_demo.mp4`
