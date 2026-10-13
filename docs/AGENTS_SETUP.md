# Configurer les agents de développement

Les fichiers du dépôt préparent le travail. Ils ne créent ni sessions d’agents ni calendrier à eux seuls. La connexion GitHub, la création du dépôt et l’activation du service restent nécessaires.

## Commencer avec Codex Cloud

Vérifier d’abord l’accès cloud de ton compte ChatGPT, avant de prendre un autre abonnement. Le guide officiel décrit des environnements cloud qui continuent les tâches lorsque l’ordinateur est en veille.

1. Dans une nouvelle tâche, sélectionner **Work in > Cloud**, puis **Select environment > Create environment**.
2. Connecter GitHub et sélectionner le dépôt privé FootScope.
3. Demander Node.js 24, l’installation `npm ci` et la validation `npm run check`.
4. Examiner le rapport de préparation, corriger les accès manquants, puis publier l’environnement.
5. Lancer une nouvelle tâche dans cet environnement avec un objectif précis et demander une PR.

`AGENTS.md` sert de consigne commune. Les profils `.github/agents/*.agent.md` sont destinés à GitHub Copilot ; dans une tâche Codex, nommer le rôle souhaité et son périmètre dans le prompt.

Source : [Environnements Codex Cloud](https://learn.chatgpt.com/docs/environments/cloud-environments).

## Option GitHub Copilot et ses agents spécialisés

Cette option nécessite un plan Copilot compatible et son cloud agent activé pour le dépôt. Les crédits et minutes utilisés par ce service sont distincts du solde API qui sert aux explications de FootScope.

Après publication du dépôt :

1. Vérifier que les quatre profils sont sur la branche par défaut.
2. Ouvrir une issue avec le modèle **Tâche pour un agent** : problème, périmètre et critères d’acceptation.
3. Dans **Assignees**, choisir Copilot et le profil adapté, ou démarrer une tâche dans l’onglet **Agents**.
4. Examiner la PR, les tests et les mesures, puis fusionner les changements acceptés.

Pour un démarrage planifié : ouvrir **Agents > Automations > Create new**, choisir une récurrence quotidienne, donner une tâche bornée et autoriser seulement les actions nécessaires à une PR. Tester avec **Run now** avant de laisser le calendrier actif. La disponibilité dépend du plan et des réglages du dépôt privé.

Sources : [Profils personnalisés](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents), [automatisations Copilot](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/create-automations), [lancer une tâche](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task).

## Organisation des rôles

| Agent                | Périmètre                    | Preuve attendue                                                       |
| -------------------- | ---------------------------- | --------------------------------------------------------------------- |
| Collecte fiable      | Provider, preuves et jobs    | Moins d’appels dupliqués et moins d’échecs, sans perdre la couverture |
| Modèles statistiques | Calculs, politique et coupon | Validation temporelle et comparaison à une référence                  |
| Interface            | `src/web/`                   | Parcours plus clair, reprise et accessibilité vérifiées               |
| Tests et performance | Tests, build et CI           | Régression reproduite, test utile et mesure avant/après               |

Commencer avec une tâche cloud à la fois. Ajouter une seconde tâche seulement sur un périmètre distinct après plusieurs PR utiles. Quatre profils ne nécessitent pas quatre agents exécutés en continu.

## Premier prompt prêt à utiliser

> Lis AGENTS.md et docs/ARCHITECTURE.md. Travaille sur une branche pour améliorer la fiabilité de la collecte. Reproduis une panne ou une duplication, puis propose une correction bornée dans provider.js, evidence.js ou jobs.js. Préserve les pauses, les secrets, les filtres et l’analyse exhaustive. Mesure les requêtes avant/après sur le même scénario simulé. Exécute npm run check. Ouvre une PR avec les preuves et les limites. Ne fusionne pas et ne déploie pas. Ne lance aucune requête payante réelle.

## Tâches prioritaires

1. **Collecte à IP dédiée :** préparer un relais authentifié et sa configuration, comparer les erreurs sur un serveur autorisé. Aucun achat ni déploiement automatique de nouvelle infrastructure.
2. **Probabilités mises en cache :** éviter de recalculer le même événement pour chaque bookmaker ; vérifier l’égalité des résultats et mesurer le CPU.
3. **Reprise durable :** reprendre un job après interruption sans ignorer des pages de cotes ni admettre des preuves périmées.
4. **Validation statistique :** construire un protocole avec séparation temporelle, données de test indépendantes et calibration. Garder l’admission pour argent réel désactivée tant que les preuves manquent.

## Vérifier la qualité et les accès

Protéger `main` avec les contrôles `checks` et une revue avant fusion, si ces fonctions sont disponibles sur le plan GitHub. Ne pas donner aux agents les clés de production pour les tests ordinaires. Toute vérification réelle de service doit avoir un budget de requêtes explicite.

Un agent doit livrer une mesure, une PR et des tests. « Optimiser tout » sans critère précis produit des changements difficiles à vérifier. Une meilleure vitesse ne prouve pas de meilleures prédictions.

Les appels quotidiens aux données de football et les agents qui améliorent le code sont deux automatisations différentes. Aucune des deux n’est activée par l’ajout de ce guide.
