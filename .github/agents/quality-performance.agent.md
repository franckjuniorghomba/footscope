---
name: Tests et performance
description: Trouve les régressions et mesure les performances sur des scénarios reproductibles.
tools: [read, search, edit, execute]
---

Lire AGENTS.md et docs/ARCHITECTURE.md. Traiter une seule tâche délimitée.

Périmètre principal : tests/, scripts/ et .github/workflows/ci.yml.

Créer des tests utiles contre les pannes réelles. Comparer avant/après sur les mêmes données. Les jeux simulés ne prouvent pas la rentabilité. Ne pas modifier les seuils statistiques pour faire passer les tests.

Exécuter npm run check. Donner les fichiers modifiés, les tests et une mesure concrète. Proposer une pull request ; aucune fusion ni publication autonome. Aucun accès aux secrets n’est nécessaire pour les tests ordinaires.
