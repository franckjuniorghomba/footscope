# Dossier des preuves du ticket — contrat JSON v1

Le ticket proposé est l'entrée du dossier. Chaque match du périmètre possède une
décision, même sans événement admissible. Chaque événement évalué est conservé
avant `compactReport`, y compris les refus. Les cotes écartées avant le modèle
figurent aussi parmi les exclusions. La vue web n'est pas modifiée.

## Route et accès

`GET /api/assistant/evidence?jobId=<uuid>&proposalId=<uuid>&offset=0&limit=50`

L'hébergement doit fournir `oai-authenticated-user-id` en supprimant toute valeur
envoyée par le client. Le propriétaire est comparé au manifeste serveur avant de
lire les preuves. Aucun paramètre client ne choisit le propriétaire. Une identité
absente, ou la valeur partagée `private-site`, reçoit 401. Un autre propriétaire
reçoit 404. Ce contrôle suppose la frontière d'authentification de Sites décrite
dans l'architecture ; un autre hébergement doit fournir cette frontière.

| Paramètre    | Contrat                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `jobId`      | Obligatoire, UUID hexadécimal minuscule avec tirets aux positions standard |
| `proposalId` | Facultatif, même forme UUID ; sinon dernière proposition complète          |
| `offset`     | Entier décimal de 0 à 999999999, défaut 0                                  |
| `limit`      | Entier décimal de 1 à 100, défaut 50                                       |

Les paramètres inconnus ou répétés sont refusés. Les réponses sont JSON avec
`Cache-Control: no-store`. Une page contient au plus 100 décisions dans l'ordre du
périmètre ; suivre `pagination.nextOffset` jusqu'à `null`. Un offset au-delà du
périmètre donne une page vide. Les lectures utilisent des clés directes, sans
listing du bucket ni lecture par match : au plus deux pages de preuves, plus trois
objets de métadonnées. Aucun appel API-Football ou OpenAI, aucune écriture pendant l'export.

| HTTP | `code`                   | Sens                                |
| ---- | ------------------------ | ----------------------------------- |
| 400  | `INVALID_EVIDENCE_QUERY` | Paramètres invalides                |
| 401  | `IDENTITY_REQUIRED`      | Identité explicite absente          |
| 404  | `EVIDENCE_NOT_FOUND`     | Inconnu, non publié ou accès refusé |
| 405  | `METHOD_NOT_ALLOWED`     | POST sur la route d'export          |
| 409  | `EVIDENCE_INCOMPLETE`    | Objet de preuve référencé manquant  |
| 503  | `STORAGE_UNAVAILABLE`    | Liaison BUCKET absente              |

Les erreurs suivent le contrat HTTP du serveur : `error`, `code`, `retryable`,
`retryAfter`. Une interruption de stockage peut produire une erreur 502. Elle
n'est pas convertie en absence d'événements intéressants.

## Schéma de la réponse

Les dates sont des chaînes ISO 8601 UTC. Une date source inconnue reste `null`.
Les nombres issus du modèle restent exploratoires ; les drapeaux de validation
restent faux. Les champs futurs s'ajoutent sans changer les champs v1.

| Champ               | Type et contenu                                                         |
| ------------------- | ----------------------------------------------------------------------- |
| `schemaVersion`     | Entier constant `1`                                                     |
| `jobId`             | UUID de l'analyse, aucune identité de propriétaire                      |
| `proposalId`        | UUID de cette proposition immuable                                      |
| `generatedAt`       | Heure de décision du ticket                                             |
| `coverage`          | `{mode, days, totals, completed, sources}` : pages examinées et sources |
| `policy`            | Copie des seuils POLICY au moment de la décision                        |
| `modelValidated`    | `false`                                                                 |
| `realMoneyEligible` | `false`                                                                 |
| `ticket`            | Objet décrit ci-dessous                                                 |
| `llm`               | Objet décrit ci-dessous                                                 |
| `decisions`         | Tableau paginé de décisions par match                                   |
| `pagination`        | `{offset, limit, total, nextOffset: integer                             | null}` |

`ticket` contient `verdict`, `selections` (événements effectivement choisis),
`combinedOdds` (produit de leurs cotes, ou `null`), `combinedProbability` (actuellement
`null`), et `rules: {singleBookmaker: true, oneSelectionPerMatch: true,
maxSelections: 4}`. `ticketProbability` est **facultatif** et sa valeur n'est jamais
recalculée par le dossier : une évolution du moteur peut le fournir.

Le classement actuel (`coupon.js`) compare, pour chaque bookmaker, le meilleur
événement de chaque match selon `prudentProbability`, puis `prudentEdge`. Il garde
jusqu'à quatre matchs. Il privilégie le nombre de sélections, puis la somme des
logarithmes des probabilités prudentes. Le dossier observe le résultat autoritatif
du moteur, sans recomposer le ticket. Les seuils restent ceux de POLICY.

Chaque entrée de `decisions` contient :

| Champ                | Type et contenu                                                   |
| -------------------- | ----------------------------------------------------------------- |
| `matchId`            | Entier identifiant le match fournisseur                           |
| `state`              | `included`, `excluded` ou `source_unavailable`                    |
| `reasons`            | Tableau de `{code: string, message?: string}`                     |
| `events`             | Tous les événements évalués et les cotes non évaluées             |
| `snapshotId`         | SHA-256 hexadécimal de l'instantané utilisé                       |
| `originalSnapshotId` | SHA-256 hexadécimal du premier instantané                         |
| `snapshot`           | Instantané utilisé pour cette proposition                         |
| `original`           | Premier instantané, même objet logique si les deux IDs sont égaux |

Un événement évalué conserve ses champs du moteur : `matchId`, `match`, `market`,
`selection`, `bookmaker`, `odd`, `updated`, `kickoff`, `probability`,
`prudentProbability`, `breakEven`, `edge`, `prudentEdge`, `minOdds`, `status` et
`realMoneyEligible`. Le dossier ajoute `state`, les motifs structurés et
`provenance: {input: "inputs", sources: ["fixture", "home", "away", "odds"],
evaluatedAt}`. Les messages originaux du moteur sont aussi dans `snapshot.report`.

Une cote non évaluée contient seulement ses identifiants de marché/bookmaker,
`odd` (chaîne fournisseur), `updated`, `state`, `reasons` et une provenance vers
`quotes`. Aucune probabilité n'est inventée pour elle.

## Instantanés, sources et reproduction

Un instantané contient `schemaVersion`, `evaluatedAt`, `modelVersion`, `policy`,
`modelParameters`, `sources`, `inputs`, `quotes`, `report`, `screeningReasons`.
`report` conserve le modèle, tous ses événements, les motifs communs et la liste
des sources manquantes. Il omet les noms de joueurs et les absences individuelles.

`sources` associe chaque entrée (`fixture`, `home`, `away`, `odds`, `injuries`,
`lineups`) à `{provider: "API-Football", query?: string, retrievedAt: string|null,
status: "available"|"unavailable"|"not_requested"}`. `observedAt` peut documenter
l'heure de préparation du périmètre. Le module qui prépare celui-ci ne transmet
pas l'heure de réponse fournisseur : le dossier signale donc explicitement cette
heure comme inconnue. Les revérifications peuvent disposer de l'heure du cache.

Pour les cotes paginées, `sources.odds.records` indique la requête et l'heure de
collecte propres à chaque bookmaker conservé, avec l'heure `updated` fournisseur.
Chaque ligne de `quotes` conserve également `collection: {query, retrievedAt}`
quand disponible. Pour un match sans cote, `sources.odds.coverage` renvoie aux
pages effectivement collectées. `coverage.sources` du dossier couvre toutes les
pages de l'analyse, y compris celles dont la réponse ne contient aucune cote.

`inputs` est une projection des entrées réellement utilisées par `assessMatch` :
fixture (ID, dates/statut, équipes, ligue, buts), historiques domicile/extérieur
avec dates, scores et IDs d'équipes, cotes datées, `retrievedAt`, erreurs sous forme
de drapeaux, compositions dont seules les tailles de `startXI` sont conservées.
Les joueurs sont supprimés ; chaque entrée XI est un objet vide. `injuries` est
vide car ce tableau ne participe à aucun calcul ni filtre, hormis la disponibilité
de sa source conservée dans `errors`. Ce format permet une reproduction numérique
sans identité de joueur ni message d'erreur fournisseur libre.

Pour un instantané passé au modèle :

```js
const replay = assessMatch(snapshot.inputs, Date.parse(snapshot.evaluatedAt));
// replay.model et replay.events reproduisent snapshot.report.model/events.
```

Le test vérifie cette égalité sur **tous les chiffres des événements**, pas seulement
sur le statut. Les historiques à dix matchs, leur antériorité et les moyennes de
buts renvoient aux entrées datées. Le modèle v1 enregistre 30 termes de Poisson,
les multiplicateurs de sensibilité `[0.75, 1, 1.25]` et la déduction prudente `0.05`.
Les cotes fournissent `breakEven = 1/odd`, `edge = probability*odd-1`,
`prudentEdge = prudentProbability*odd-1`, `minOdds = 1.02/prudentProbability`.
Les seuils renvoient à POLICY ; la cote combinée renvoie aux sélections du ticket.
Un examen arrêté avant le modèle reste un examen de filtrage, sans modèle reconstruit.

## Motifs structurés

| Codes                                           | Décision expliquée                                     |
| ----------------------------------------------- | ------------------------------------------------------ |
| `POLICY_PASSED`, `TICKET_SELECTED`              | Admission par les filtres puis sélection par le moteur |
| `HISTORY_INSUFFICIENT`, `HISTORY_STALE`         | Historique trop court ou trop ancien                   |
| `SOURCE_UNAVAILABLE`                            | Source requise indisponible                            |
| `LINEUPS_UNCONFIRMED`                           | XI non confirmés à moins de 90 minutes                 |
| `MATCH_STARTED`                                 | Match déjà commencé                                    |
| `ODDS_STALE_OR_INVALID`                         | Cote absente, future ou périmée                        |
| `PROBABILITY_BELOW_POLICY`, `EDGE_BELOW_POLICY` | Seuil statistique non satisfait                        |
| `MARKET_UNMODELED`                              | Événement non pris en charge par le modèle             |
| `MARKET_NOT_SUPPORTED`                          | Marché écarté par le filtre de collecte                |
| `INVALID_ODDS`                                  | Cote non finie ou inférieure/égale à 1                 |
| `NO_ODDS_AFTER_COMPLETE_COVERAGE`               | Aucun enregistrement après toutes les pages            |
| `NO_SUPPORTED_FRESH_QUOTES`                     | Aucun marché pris en charge et frais                   |
| `QUOTE_NOT_EVALUATED`                           | Cote conservée, examen arrêté avant modélisation       |
| `ONE_SELECTION_PER_MATCH`                       | Une autre sélection de ce match figure dans le ticket  |
| `SINGLE_BOOKMAKER`                              | Autre bookmaker que celui choisi pour le ticket        |
| `MAX_SELECTIONS`                                | Candidat exclu d'un ticket qui atteint la limite       |
| `EVIDENCE_STALE`                                | Examen trop ancien pour composer le ticket             |
| `CANDIDATE_RANKING`                             | Autre candidat mieux classé                            |
| `SCREENING_REJECTION`                           | Motif serveur conservé sans code spécialisé            |

Les codes de composition décrivent la première contrainte applicable ; les
autres règles restent visibles dans `ticket.rules`. Si une source manque, le
match prend l'état `source_unavailable`, au lieu de masquer l'échec en refus ordinaire.

## Ce que le LLM reçoit

`llm` contient `requested`, `model`, `input`, `inputFormat`, `instructions`,
`parameters` et `outcome`. L'entrée JSON est reconstruite à partir du résultat
autoritatif avant enrichissement par le LLM : chiffres, sélections, refus, seuils,
risques statistiques et couverture. Le test la compare intégralement à la requête
OpenAI simulée, ainsi que les instructions et paramètres. Le format de transport
est `inputFormat + JSON.stringify(input)` ; l'ordre des clés n'est pas significatif.
Les rapports complets ne sont pas transmis au LLM actuellement.

`requested` indique le parcours d'explication configuré ; il ne garantit pas une
livraison réseau, car l'explication peut être mise en cache ou échouer.
Pour un ticket vide ou un LLM non configuré, il vaut faux, avec une entrée et des
instructions nulles. `outcome` est le moteur de la réponse finale. Le dossier ne
permet jamais au LLM de modifier les sélections, les chiffres ou les filtres.

## Conservation et limites

Les nouveaux objets sont sous `jobs/<jobId>/evidence/` :

- `quotes/<matchId>.json` : collecte complète des marchés, avant filtrage ;
- `snapshots/<sha256>.json` : entrée et examen avant compaction, écriture conditionnelle ;
- `original/<matchId>.json` : référence initiale, créée une seule fois ;
- `proposals/<proposalId>/pages/<index>.json` : jusqu'à 100 décisions complètes par page ;
- `proposals/<proposalId>/ticket.json` : métadonnées publiées après toutes les décisions ;
- `latest.json` : référence vers la dernière proposition entièrement conservée.

Le rapport compact porte `evidenceSnapshotId`, afin que sa proposition conserve
exactement la preuve utilisée, même pendant une revérification concurrente.
Une reprise en cache n'écrit aucune preuve ; une nouvelle revérification conserve
un nouvel instantané et ne remplace jamais le premier. Chaque proposition a son
UUID et reste exportable via cet UUID après les propositions suivantes. Les pages
contiennent les instantanés utilisés et initiaux : cette duplication volontaire
augmente le stockage et supprime les lectures N+1 lors de l'export.

L'expiration de collecte de 24 heures n'empêche pas l'export. Aucun effacement
automatique n'est ajouté ; les règles de cycle de vie R2 doivent conserver ensemble
manifeste et preuves. Le dossier ne rétrocrée pas les preuves d'analyses antérieures
au changement ni celles du parcours historique sans `jobId`.

Les erreurs libres, en-têtes, propriétaire, noms de joueurs et objets fournisseur
non autorisés ne sont pas exportés. Les noms et valeurs des secrets football,
OpenAI et relais sont expurgés à la conservation puis à l'export. Les sources
partiellement inconnues restent signalées. Une reproduction logicielle n'est
pas une validation prédictive du modèle.
