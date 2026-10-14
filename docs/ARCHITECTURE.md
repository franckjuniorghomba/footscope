# Architecture actuelle

L’exécution publique est un Cloudflare Worker. Node.js sert au développement, au build et aux tests. L’interface est en HTML/CSS/JavaScript ; ce dépôt n’est pas une application React/Express.

## Parcours d’une proposition

1. `assistant.js` crée une analyse avec tous les matchs à venir correspondant à la date GMT−5 et aux filtres.
2. `jobs.js` parcourt les cotes paginées. Pour vingt matchs ou moins, il collecte les cotes par match ; pour un périmètre plus large, il parcourt les deux dates UTC nécessaires.
3. Chaque match reçoit soit un motif d’exclusion, soit une analyse approfondie de ses preuves.
4. `statistics.js` estime les événements pris en charge et applique `policy.js`.
5. `coupon.js` compare les événements admissibles, retient un événement par match et compose les tickets par bookmaker : le produit des probabilités prudentes doit rester supérieur ou égal à 0,5, avec quatre sélections maximum. Le choix entre bookmakers conserve les règles de classement et de préférence existantes.
6. Les matchs envisagés sont revérifiés. Aucun coupon complet n’est présenté tant qu’il manque des examens.
7. `assistant.js` transmet les probabilités combinées prudente et exploratoire, le seuil et les candidats dont l’ajout ferait passer sous le seuil. `llm.js` explique pourquoi ces sélections et pourquoi pas plus, sans inventer de chiffres ni changer le ticket ou le statut. Le prompt et la projection de l’entrée sont partagés avec `jobs.js` pour conserver exactement la requête dans le dossier de preuves. Le repère descriptif `market` sans marge est exclu de l’entrée ; les noms textuels des marchés sont conservés. Sans LLM disponible, le résumé rappelle la probabilité prudente combinée et le caractère non validé du modèle.
8. La proposition fige `ticketProbability`, `combinedProbability = ticketProbability` et `modelVersion = MODEL_VERSION` dans l’observation. `storage.js` conserve les propositions et permet le relevé des résultats ; le suivi par ticket compare la probabilité annoncée enregistrée à l’observé sans la recalculer.

## Données et isolation

Les préfixes R2 `api-cache/`, `api-control/`, `jobs/`, `observations/` et `latest/` ont des rôles distincts. Les analyses sont associées à l’identité fournie par l’hébergement. Le jeton d’accès de service ne contient pas d’identité visiteur ; il suit un parcours séparé sur le site privé.

`worker/index.js` est le point d’entrée et conserve quelques exports testables. `scripts/build.mjs` regroupe les modules et incorpore les ressources web dans l’artefact. L’interface reçoit son JavaScript et sa feuille de style par des routes distinctes.

## Priorités de performance

1. Stabiliser l’accès fournisseur : mesurer les refus et comparer une collecte à IP dédiée avec les appels actuels avant toute migration.
2. Réduire les requêtes dupliquées, conserver la couverture exhaustive et mesurer le taux de cache.
3. Réduire le coût CPU des probabilités identiques entre bookmakers, avec égalité des résultats testée.
4. Ajouter une reprise durable des analyses longues et mesurer les expirations de preuves.
5. Construire une validation temporelle des modèles. Mesurer calibration, Brier et rendement simulé avec intervalles et taille d’échantillon ; ne pas annoncer des gains sur quelques cas.

La priorité 1 est un problème d’accès externe ; davantage d’agents ne crée pas une IP dédiée. La priorité 5 est distincte de la vitesse de l’application.
