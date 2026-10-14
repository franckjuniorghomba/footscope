# Dossier des preuves du ticket — contrat JSON v2

Chaque match du périmètre possède une décision, même sans candidat admissible.
Les événements avec une probabilité calculée sont conservés avant `compactReport`,
y compris les refus. Les cotes non modélisées ou non évaluées sont comptées par
marché et code de refus ; leurs valeurs originales restent dans l'instantané.
La vue web et les seuils du moteur ne changent pas.

## Route et accès

`GET /api/assistant/evidence?jobId=<uuid>&proposalId=<uuid>&offset=0&limit=50&includeSnapshots=none`

L'hébergement doit fournir `oai-authenticated-user-id` en supprimant toute valeur
envoyée par le client. Le propriétaire est comparé au manifeste serveur avant de
lire les pages ou les instantanés. Aucun paramètre client ne choisit le propriétaire
ni un identifiant d'instantané arbitraire. Une identité absente ou partagée
(`private-site`) reçoit 401 ; un autre propriétaire reçoit 404, comme un job inconnu.
Ce contrôle suppose la frontière d'authentification de Sites décrite dans
l'architecture ; un autre hébergement doit fournir cette frontière.

| Paramètre          | Contrat                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `jobId`            | Obligatoire, UUID hexadécimal minuscule avec tirets standard          |
| `proposalId`       | Facultatif, UUID ; sinon dernière proposition complète                |
| `offset`           | Entier décimal de 0 à 999999999, défaut 0                             |
| `limit`            | Nombre maximum de décisions, entier de 1 à 100, défaut 50             |
| `includeSnapshots` | `none` (défaut), `current` ou `original`, une seule version par appel |

Les paramètres inconnus ou répétés sont refusés. Les réponses sont JSON avec
`Cache-Control: no-store`. Suivre **`pagination.nextOffset`**, jusqu'à `null` :
le plafond d'octets peut réduire le nombre rendu sous `limit`. Aucun match n'est
omis ; un offset au-delà du périmètre donne une page vide.

Les lectures utilisent des clés directes, sans listing R2 : trois métadonnées
(deux si `proposalId` est explicite), au plus `ceil(limit / 3) + 1` pages physiques,
et **au plus `limit` lectures d'instantanés** si demandés. Les identifiants viennent
uniquement des décisions autorisées. Les instantanés sont lus séquentiellement et
dédoublonnés dans la réponse. Aucun appel API-Football/OpenAI ni écriture à l'export.

| HTTP | `code`                   | Sens                                     |
| ---- | ------------------------ | ---------------------------------------- |
| 400  | `INVALID_EVIDENCE_QUERY` | Paramètres invalides                     |
| 401  | `IDENTITY_REQUIRED`      | Identité explicite absente               |
| 404  | `EVIDENCE_NOT_FOUND`     | Inconnu, non publié ou accès refusé      |
| 405  | `METHOD_NOT_ALLOWED`     | POST sur la route d'export               |
| 409  | `EVIDENCE_INCOMPLETE`    | Page ou instantané demandé manquant      |
| 413  | `EVIDENCE_TOO_LARGE`     | Objet trop grand pour une réponse bornée |
| 503  | `STORAGE_UNAVAILABLE`    | Liaison BUCKET absente                   |

Les erreurs HTTP suivent le contrat `error`, `code`, `retryable`, `retryAfter`.
Une interruption R2 pendant l'export peut produire 502. Elle n'est pas convertie
en absence d'événements intéressants.

## Schéma de la réponse

Les dates sont ISO 8601 UTC ; une heure source inconnue reste `null`.

| Champ               | Type et contenu                                                         |
| ------------------- | ----------------------------------------------------------------------- |
| `schemaVersion`     | `2`                                                                     |
| `status`            | `complete`                                                              |
| `jobId`             | UUID de l'analyse, aucune identité de propriétaire                      |
| `proposalId`        | UUID de cette proposition immuable                                      |
| `generatedAt`       | Heure de décision du ticket                                             |
| `coverage`          | `{mode, days, totals, completed, sources}` : pages examinées et sources |
| `policy`            | Copie de POLICY au moment de la décision                                |
| `modelValidated`    | `false`                                                                 |
| `realMoneyEligible` | `false`                                                                 |
| `ticket`            | Verdict, sélections, cotes/probabilités et règles                       |
| `llm`               | Entrée sémantique, instructions, paramètres, résultat de l'explication  |
| `decisions`         | Décisions paginées par match                                            |
| `snapshots`         | Instantanés demandés, chacun identifié par `snapshotId` ; sinon `[]`    |
| `pagination`        | `{offset, limit, total, nextOffset: integer \| null}`                   |

`ticket` contient `verdict`, `selections`, `combinedOdds` (produit des cotes, sinon
`null`), `combinedProbability` (actuellement `null`), et
`rules: {singleBookmaker: true, oneSelectionPerMatch: true, maxSelections: 4}`.
`ticketProbability`, `ticketProbabilityExploratory` et `noTicketReason` sont
facultatifs ; le dossier conserve les valeurs du serveur sans les recalculer,
y compris le motif d'absence de ticket lorsque le LLM n'est pas configuré.

Le classement compare les candidats selon `prudentProbability`, puis `prudentEdge`,
avec au plus quatre matchs et un événement par match. Il compare les bookmakers
par taille de ticket puis probabilité prudente combinée. À taille égale, Bet365 est
préféré si sa probabilité atteint 90 % de celle du meilleur ticket. Sa casse et ses
espaces sont normalisés comme dans le moteur. Le dossier observe le résultat du
moteur sans recomposer le ticket, ni dépendre de la PR #7.

Chaque décision contient :

| Champ                | Type et contenu                                          |
| -------------------- | -------------------------------------------------------- |
| `matchId`            | Entier, identifiant fournisseur                          |
| `state`              | `included`, `excluded` ou `source_unavailable`           |
| `reasons`            | Motifs `{code, message?}`, dédoublonnés par code         |
| `events`             | Événements avec probabilité calculée, retenus ou refusés |
| `quoteSummary`       | Agrégats `{market, code, count}` des autres cotes        |
| `snapshotId`         | SHA-256 de l'instantané utilisé                          |
| `originalSnapshotId` | SHA-256 du premier instantané, créé une seule fois       |

**Les pages ne contiennent ni `snapshot`, ni `original`.** Demander les preuves
courantes avec `includeSnapshots=current`, puis éventuellement les initiales avec
`includeSnapshots=original`, en reprenant les mêmes `offset` et `proposalId`.

Un événement conserve les champs du moteur : identifiants, marché, sélection,
bookmaker, cote, dates, `probability`, `prudentProbability`, `breakEven`, `edge`,
`prudentEdge`, `minOdds`, `status`, `realMoneyEligible`. Le dossier ajoute `state`,
les motifs structurés et `provenance: {input: "inputs", sources: ["fixture", "home",
"away", "odds"], evaluatedAt}`. Les agrégats renvoient à `inputs.odds` ; leurs codes
s'ajoutent aux motifs du match. Les motifs communs restent dans l'instantané.
Aucune probabilité n'est inventée pour une cote non modélisée.

## Instantanés, sources et reproduction

Un instantané contient `schemaVersion`, `evaluatedAt`, `modelVersion`, `policy`,
`modelParameters`, `sources`, `inputs`, `quoteSummary`, `report`, `screeningReasons`.
`report.events` ne conserve individuellement que les événements avec probabilité.
Les cotes ont **une seule copie**, dans `inputs.odds` ; il n'existe plus de `quotes`.

`sources` associe chaque entrée à `{provider: "API-Football", query?, retrievedAt,
status: "available"|"unavailable"|"not_requested"}`. `observedAt` peut documenter
l'heure de préparation du périmètre, sans inventer l'heure fournisseur inconnue.
Pour les cotes paginées, `sources.odds.records` indique la requête, l'heure de
collecte par bookmaker et l'heure `updated` fournisseur. Chaque ligne de
`inputs.odds` conserve `collection: {query, retrievedAt}` quand disponible.
Sans cote, `sources.odds.coverage` renvoie aux pages collectées ; `coverage.sources`
couvre toutes les pages de l'analyse, y compris celles vides.

`inputs` contient fixture, historiques domicile/extérieur avec dates, scores et
IDs d'équipes, cotes datées (y compris les marchés filtrés), `retrievedAt`, erreurs
comme drapeaux et tailles des XI. Les joueurs sont supprimés ; chaque entrée XI
est un objet vide. `injuries` est vide : seules les erreurs de sa source participent
aux filtres. Les messages fournisseur libres ne sont pas conservés.

Pour un instantané passé au modèle :

```js
const replay = assessMatch(snapshot.inputs, Date.parse(snapshot.evaluatedAt));
// replay.model reproduit snapshot.report.model.
// replay.events.filter(e => e.probability !== null) reproduit snapshot.report.events.
```

Les tests vérifient tous les chiffres, aussi sur les 900 cotes par match.
Le modèle enregistre 30 termes de Poisson, les multiplicateurs `[0.75, 1, 1.25]`
et la déduction prudente `0.05`. Les cotes permettent de reproduire `breakEven`,
`edge`, `prudentEdge` et `minOdds`. Un examen arrêté avant le modèle reste un
filtrage ; ses événements ne sont pas reconstruits artificiellement.

## Motifs structurés

| Codes                                                   | Décision expliquée                                  |
| ------------------------------------------------------- | --------------------------------------------------- |
| `POLICY_PASSED`, `TICKET_SELECTED`                      | Admission puis sélection                            |
| `HISTORY_INSUFFICIENT`, `HISTORY_STALE`                 | Historique trop court ou trop ancien                |
| `SOURCE_UNAVAILABLE`, `LINEUPS_UNCONFIRMED`             | Source ou XI requis indisponible                    |
| `MATCH_STARTED`, `ODDS_STALE_OR_INVALID`                | Match commencé ou cote périmée/invalide             |
| `PROBABILITY_BELOW_POLICY`, `EDGE_BELOW_POLICY`         | Seuil statistique non satisfait                     |
| `MARKET_UNMODELED`, `MARKET_NOT_SUPPORTED`              | Cote sans modèle ou marché filtré                   |
| `INVALID_ODDS`, `QUOTE_NOT_EVALUATED`                   | Cote invalide ou examen arrêté avant modélisation   |
| `NO_ODDS_AFTER_COMPLETE_COVERAGE`                       | Aucune cote après toutes les pages                  |
| `NO_SUPPORTED_FRESH_QUOTES`                             | Aucun marché pris en charge et frais                |
| `ONE_SELECTION_PER_MATCH`, `SINGLE_BOOKMAKER`           | Règles de composition                               |
| `MAX_SELECTIONS`, `EVIDENCE_STALE`, `CANDIDATE_RANKING` | Limite de taille, examen ancien ou autre classement |
| `TICKET_PROBABILITY_BELOW_THRESHOLD`                    | Ajout du candidat sous le seuil du ticket           |
| `SCREENING_REJECTION`                                   | Motif serveur sans code spécialisé                  |

L'ensemble des codes est ouvert. Le code de probabilité du ticket est prévu pour
BIS-176 : il n'est produit que si l'instantané fournit `policy.minTicketProbability`
et que le produit prudent des sélections avec ce candidat tombe sous ce seuil.
Il ne crée aucun seuil dans cette PR. Les règles de composition décrivent la
première contrainte applicable ; les autres restent visibles dans `ticket.rules`.

## Explication LLM

`llm` contient `requested`, `model`, `input`, `inputFormat`, `instructions`,
`parameters`, `outcome`. L'entrée sémantique est reconstruite depuis le résultat
serveur avant enrichissement LLM. Le test la compare intégralement à la requête
OpenAI simulée, avec les instructions et paramètres. Son format de transport est
`inputFormat + JSON.stringify(input)` ; l'ordre des clés n'est pas significatif.

`requested` décrit le parcours configuré, pas une livraison réseau garantie
(cache ou échec possible). Un ticket vide ou un LLM non configuré donne une entrée
et des instructions nulles. Le LLM ne modifie jamais les sélections ni les filtres.

## Plafonds, conservation et échecs

Tous les plafonds sont mesurés en **octets UTF-8**, avant écriture :

| Objet                           | Plafond |
| ------------------------------- | ------- |
| Décision                        | 128 Kio |
| Page physique (3 décisions max) | 512 Kio |
| Métadonnées de proposition      | 256 Kio |
| Ensemble écrit par proposition  | 8 Mio   |
| Instantané                      | 512 Kio |
| Réponse HTTP                    | 1 Mio   |

Le budget de proposition inclut pages et métadonnées, avec 1 Kio réservé au pointeur
et au marqueur d'échec. Les instantanés sont conservés séparément lors des scans,
puis référencés ; ils ne sont pas réécrits par `finishEvidence`. Le budget de 8 Mio
n'est pas un quota global par analyse ou par utilisateur. Le moteur continue
l'examen de tous les matchs : un dépassement rend le dossier incomplet, sans
publier un sous-ensemble de décisions comme dossier complet.

Les objets sont sous `jobs/<jobId>/evidence/` : `quotes/<matchId>.json` pour la
collecte brute, `snapshots/<sha256>.json` pour les preuves, `original/<matchId>.json`
pour la référence initiale, `proposals/<proposalId>/pages/<index>.json` pour les
décisions, `proposals/<proposalId>/ticket.json` pour les métadonnées et `latest.json`
pour la dernière proposition complète. `evidenceSnapshotId` du rapport compact
lie la proposition à la preuve utilisée, même pendant une revérification concurrente.

Un échec du dossier **après l'observation et l'explication LLM** ne transforme pas
le ticket en erreur HTTP. `propose` rend le ticket avec
`evidence: {schemaVersion: 2, proposalId, status: "incomplete", code}`. Les codes
sont `EVIDENCE_INCOMPLETE`, `EVIDENCE_TOO_LARGE`, `EVIDENCE_STORAGE_FAILED`.
Un journal structuré contient uniquement l'événement et le code, sans erreur R2
libre. Un `proposals/<proposalId>/status.json` est tenté ; si R2 est aussi indisponible
pour ce marqueur, le champ de réponse et un second journal signalent l'échec.
La dernière référence complète est préservée. Les pages partielles peuvent rester
orphelines ; aucune purge automatique ni nouvelle observation de reprise n'est ajoutée.

Les originaux et propositions publiées restent immuables. L'expiration de collecte
de 24 heures n'empêche pas l'export. Les anciens dossiers v1 ne sont pas réécrits ;
leur taille de page historique (100) reste reconnue, sous réserve du nouveau plafond
HTTP. Un ancien objet indivisible trop volumineux peut donc recevoir 413. Aucune
rétrocréation des preuves historiques ni du parcours sans `jobId` n'est ajoutée.

Les règles R2 de cycle de vie doivent conserver ensemble manifeste et preuves.
Les identités, noms de joueurs, erreurs libres, en-têtes et objets non autorisés
sont exclus. Les noms et valeurs des secrets football, OpenAI et relais sont
expurgés à la conservation et à l'export. Pour une valeur de secret de moins de
16 caractères, seuls ses tokens autonomes sont remplacés, afin de préserver les
champs et les mots du schéma. Une reproduction logicielle n'est pas une validation
prédictive du modèle.
