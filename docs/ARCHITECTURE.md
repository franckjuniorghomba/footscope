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

`statistics.js` ajoute un tableau descriptif `market`, calculé par `market.js` sur les cotes déjà collectées. Chaque entrée décrit un 1X2 (`Match Winner`) complet d'un même bookmaker et relevé : `odds`, `probabilities`, `overround`, `updated`, `method: proportional` et une explication de la marge. La marge implicite vaut `somme(1/cote) - 1` et les probabilités `(1/cote) / somme(1/cote)` (somme vérifiée à 1e-9 près). Il faut exactement Home/Draw/Away avec des cotes finies supérieures à 1 et un relevé âgé au plus de 30 minutes (futur toléré jusqu'à 5 minutes, tolérance également appliquée aux événements). Aucun assemblage de relevés ou bookmakers, aucune normalisation Double Chance ; tableau vide sans marché valide. Ce champ ne participe ni aux verdicts ni au ticket et est exclu de la projection LLM partagée avec le dossier de preuves. L'affichage relève de BIS-175 ; aucun appel fournisseur supplémentaire.

Valeur face au marché (BIS-200, descriptive). `statistics.js` conserve aussi `sharpReference` : le dernier relevé Pinnacle brut du match (marchés pris en charge), dont l'âge est jugé au moment de la comparaison. `assistant.js` range dans l'objet racine `market` du résultat (retiré par `buildLlmInput`, donc absent de l'entrée LLM et de sa copie dans le dossier de preuves) une entrée par sélection, sélection examinée et candidat écarté (tous les candidats serveur, avant la troncature à cinq de `excludedCandidates` destinée au LLM), avec `updated` (heure fournisseur de la cote, `null` si événement absent), `role` et `index` (position dans son groupe, clé d'affichage stable même pour une sélection absente du fournisseur) : `fairOdd`, `fairProbability`, `marketValue = cote bet365 / cote juste Pinnacle − 1`, `hasValue`, `atFairOdd` (écart d'au plus 1e-9, affiché « À la cote juste »), ou `null` avec `reasonCode`/`reason` (`NO_REFERENCE`, `NOT_BET365`, `OTHER_MATCH`, `STALE_QUOTE`, `STALE_REFERENCE`, `INCOMPLETE_MARKET`, `UNSUPPORTED`, `EVENT_MISSING`), plus `allSelectionsHaveValue` (oui seulement si chaque sélection a une valeur calculée strictement positive ; `null` sans sélection). Cote juste : 1X2 par `marketReference` ; plus/moins (même ligne) et « les deux marquent » normalisés à deux issues ; double chance comme somme de deux issues 1X2 justes, jamais normalisée directement. Les deux relevés doivent être du même match et âgés d'au plus 30 minutes (futur toléré 5 minutes). Seuls les événements serveur sont comparés, jamais une cote envoyée par le client. Ni les verdicts, ni le ticket, ni les seuils ne changent ; aucune requête fournisseur supplémentaire.

Les préfixes R2 `api-cache/`, `api-control/`, `jobs/`, `observations/`, `latest/` et `odds-archive/` (historique des relevés de cotes, voir `docs/ODDS-ARCHIVE.md`) ont des rôles distincts. Les analyses sont associées à l’identité fournie par l’hébergement. Le jeton d’accès de service ne contient pas d’identité visiteur ; il suit un parcours séparé sur le site privé.

`worker/index.js` est le point d’entrée et conserve quelques exports testables. `scripts/build.mjs` regroupe les modules et incorpore les ressources web dans l’artefact. L’interface reçoit son JavaScript et sa feuille de style par des routes distinctes.

## Priorités de performance

1. Stabiliser l’accès fournisseur : mesurer les refus et comparer une collecte à IP dédiée avec les appels actuels avant toute migration.
2. Réduire les requêtes dupliquées, conserver la couverture exhaustive et mesurer le taux de cache.
3. Réduire le coût CPU des probabilités identiques entre bookmakers, avec égalité des résultats testée.
4. Ajouter une reprise durable des analyses longues et mesurer les expirations de preuves.
5. Construire une validation temporelle des modèles. Mesurer calibration, Brier et rendement simulé avec intervalles et taille d’échantillon ; ne pas annoncer des gains sur quelques cas.

La priorité 1 est un problème d’accès externe ; davantage d’agents ne crée pas une IP dédiée. La priorité 5 est distincte de la vitesse de l’application.

## Fraîcheur des cotes (BIS-217)

`POLICY.maxOddsAgeMs` fixe l’admission à 24 heures incluses ; statistiques, présélection, coupon et examen final utilisent ce seuil. L’interface applique la même fenêtre et affiche l’âge fournisseur sur les sélections, examens et tous les candidats (via `market.checks.updated`). Une heure absente, invalide ou future est signalée explicitement. L’âge est calculé au rendu, sans appel réseau supplémentaire.

`POLICY.maxMarketOddsAgeMs` reste à 30 minutes pour le repère sans marge et le badge BIS-200 : la comparaison de valeur requiert deux relevés récents. Ce choix prudent évite d’étendre la validité descriptive de la comparaison avec la seule extension de l’admission. Entre 30 minutes et 24 heures, une sélection peut être admissible et sa comparaison indisponible (`STALE_QUOTE` ou `STALE_REFERENCE`). La tolérance future reste de 5 minutes pour les deux fenêtres. Le seuil du ticket de 0,5, les autres filtres et les indicateurs de validation restent inchangés.

Pour le pilote du week-end, les 24 heures mesurent l’âge de `updated` API-Football, pas la disponibilité effective du prix. Chaque sélection, le ticket et sa copie dans le coupon affichent un avertissement demandant de vérifier la cote actuelle chez le bookmaker, avec `minOdds` serveur à côté, arrondi vers le haut au centième. Si le minimum manque (coupon manuel ou ancienne donnée), il est signalé indisponible, sans valeur inventée. Aucun appel fournisseur supplémentaire.
