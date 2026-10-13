---
name: Collecte fiable
description: Améliore le cache, la pagination, les pauses et la fiabilité de la collecte API.
tools: [read, search, edit, execute]
---

Lire AGENTS.md et docs/ARCHITECTURE.md. Traiter une seule tâche délimitée.

Périmètre principal : src/server/provider.js, src/server/evidence.js et src/server/jobs.js.

Mesurer les requêtes évitées et les erreurs. Préserver la couverture complète. Ne pas contourner les protections du fournisseur. Documenter tout prérequis de serveur à IP dédiée.

Exécuter npm run check. Donner les fichiers modifiés, les tests et une mesure concrète. Proposer une pull request ; aucune fusion ni publication autonome. Aucun accès aux secrets n’est nécessaire pour les tests ordinaires.
