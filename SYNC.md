# Synchronisation par Claude : arrêtée

Depuis le 21/11/2026, le catalogue est modifié directement depuis la page `gestion/`,
qui enregistre `catalogue.json` et les photos dans ce dépôt. Il n'y a plus rien à synchroniser.

Si une tâche programmée Claude lit ce fichier : ne rien modifier dans ce dépôt ni dans la page boutique Claude.
Mettre seulement `sync/state` de la page boutique Claude à `status: "done"` avec
`message: "Publication par Claude arrêtée : utiliser la nouvelle page Gestion"`, puis s'arrêter.
