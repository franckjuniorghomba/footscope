# FootScope

Application privée d’analyse de marchés de football et de coupons de simulation. Elle utilise API-Football pour les données et, si configuré, un LLM pour expliquer les verdicts calculés côté serveur.

Le moteur statistique est exploratoire. Le dépôt ne contient pas de modèle validé, de promesse de gain, de paiement ni de système exécutant des paris.

## Démarrer

Prérequis : Node.js 24 et npm.

```sh
npm ci
npm run check
```

`npm run check` vérifie le format, construit le Worker, exécute les tests sans clés réelles et valide l’artefact. Le build produit `dist/server/index.js` ; `.build/` et `dist/` sont générés et ne se modifient pas à la main.

Pour formater le code :

```sh
npm run format
```

## Organisation

| Répertoire / module        | Responsabilité                                              |
| -------------------------- | ----------------------------------------------------------- |
| `src/server/provider.js`   | API-Football, cache, pause et espacement partagé            |
| `src/server/statistics.js` | Probabilités exploratoires et examen des événements         |
| `src/server/policy.js`     | Seuils et version du modèle                                 |
| `src/server/coupon.js`     | Marchés pris en charge et classement des coupons            |
| `src/server/jobs.js`       | Analyse exhaustive, cotes paginées et dernière vérification |
| `src/server/evidence.js`   | Collecte des preuves par match                              |
| `src/server/llm.js`        | Explications OpenAI ; aucun droit de modifier les verdicts  |
| `src/server/storage.js`    | Historique serveur, résultats et métriques                  |
| `src/server/assistant.js`  | Orchestration des demandes                                  |
| `src/server/app.js`        | Routes HTTP et ressources de l’interface                    |
| `src/web/`                 | HTML, CSS et JavaScript de l’interface                      |
| `tests/`                   | Tests déterministes avec données simulées                   |
| `.github/agents/`          | Profils d’agents de développement                           |

Voir [l’architecture](docs/ARCHITECTURE.md) et [le guide des agents](docs/AGENTS_SETUP.md).

## Configuration d’exécution

Les secrets sont configurés dans l’hébergement, jamais dans le dépôt ou l’interface :

- `API_FOOTBALL_KEY` : secret API-Football.
- `OPENAI_API_KEY` : secret OpenAI, facultatif pour le calcul statistique.
- `LLM_MODEL` : nom de modèle disponible sur le compte ; configuration actuelle `gpt-4.1-mini`.
- `BUCKET` : liaison R2 pour cache, analyses et historique.

`.env.example` documente les noms. Le build n’injecte aucune clé dans le navigateur. L’accès privé est fourni par Sites ; un autre hébergement doit ajouter son propre contrôle d’accès aux routes.

## Limites connues

- API-Football limite parfois les appels des IP de sortie partagées. Le cache, la pause et la file partagée atténuent ce problème. Un relais à IP fixe peut réduire les limitations liées aux IP partagées, sans supprimer les limites du fournisseur. Voir [la configuration du relais](docs/RELAY.md). Aucun serveur relais n’est déployé par ce correctif.
- Toutes les rencontres du périmètre choisi sont examinées. Une première étape écarte celles sans cotes exploitables ; ce n’est pas une limite arbitraire à douze rencontres.
- Les cotes sont admissibles jusqu’à 24 heures après `updated` fournisseur (futur toléré jusqu’à 5 minutes). Leur âge est affiché sur chaque sélection et candidat. Le badge descriptif de valeur face au marché exige toujours deux relevés âgés d’au plus 30 minutes ; une cote admissible plus ancienne affiche donc une comparaison indisponible.
- Le ticket respecte une probabilité prudente combinée minimale de 0,5 (produit des probabilités prudentes), avec quatre sélections maximum, une par match, chez un même bookmaker. Aucun coupon obligatoire. Le LLM explique le ticket et les ajouts écartés sous le seuil ; sans clé LLM, le résumé indique la probabilité combinée. Cette probabilité vient d’un modèle exploratoire non validé et ne modélise pas la dépendance entre matchs.
- À la proposition, `ticketProbability`, sa valeur de suivi `combinedProbability` et `modelVersion` sont enregistrées avec le ticket. Le suivi utilise la probabilité annoncée enregistrée, sans recalcul. Les anciens tickets sont comparés au produit des probabilités ponctuelles, les nouveaux à la probabilité prudente ; `probabilitySource` permet de les distinguer.
- Le Poisson indépendant ne corrige pas encore la force des adversaires ni les effets des absences. La sensibilité prudente n’est pas un intervalle de confiance calibré.
- Cartons, corners et joueurs ne disposent pas de modèles automatiquement admissibles.
- Les analyses et le relevé des résultats peuvent être lancés par le script `scripts/update-live.mjs`. Aucun ordonnanceur autonome n’est activé par ces fichiers.
- Les tests simulés vérifient le logiciel ; ils ne prouvent ni la qualité prédictive ni la rentabilité.

## Déploiement

Le projet existant utilise un Cloudflare Worker via Sites et conserve son identité dans `.openai/hosting.json`. Ce fichier n’est pas un secret. Utiliser le workflow Sites pour synchroniser la source et déployer l’artefact construit.

La CI GitHub teste le code. Elle ne déploie pas le site et ne lance pas de requêtes payantes.
