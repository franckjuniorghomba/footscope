# Archive des cotes et cote de clôture

Statut : l’archive (parties 1 et 2) est en place ; la capture de clôture (partie 3) n’est **pas activée**. Ce document la cadre seulement : il n’ajoute aucun déclencheur ni aucun appel. L’activer coûte des appels API, la décision revient au responsable.

## 1. Archive des relevés déjà reçus (0 appel en plus)

`api()` (`src/server/provider.js`) appelle `archiveOdds()` (`src/server/odds-archive.js`) **uniquement** après une réponse réseau réussie d’un chemin `odds?…`. Les succès de cache (mémoire, R2), les rattachements à une requête en cours, les erreurs et les pauses du fournisseur n’arrivent jamais à l’archive. Le cache, l’espacement de 6,5 s, la file partagée `api-control/` et les compteurs de `/api/diagnostics.cache` ne changent pas.

Clé : `odds-archive/<AAAA-MM-JJ>/<fixtureId>/<update>.json`, où le jour est celui de l’horodatage `update` du relevé en GMT−5 fixe et `<update>` cet horodatage au format ISO compact (`20261014T135650592Z`). La clé ne dépend donc que de la paire `(fixtureId, update)` : un coup d’envoi absent, déplacé ou corrigé entre deux réponses ne crée jamais une deuxième écriture du même relevé. Pour retrouver les relevés d’un match joué le jour J, lire les préfixes des jours précédant J (les relevés arrivent avant le coup d’envoi) et filtrer sur `fixtureId` ; le coup d’envoi reste dans le contenu (`kickoff`).

Contenu (version 1) : `fixtureId`, `league` (id, nom, pays, saison), `kickoff`, `update`, `retrievedAt`, `query` (chemin fournisseur, sans clé), `truncated`, `droppedBookmakers` et `bookmakers[]` → `{ id, name, markets[] → { name, values[] → { value, odd } } }`. Seuls les marchés gérés sont gardés (`Match Winner`, `Double Chance`, `Goals Over/Under`, `Both Teams Score`), une fois chacun par bookmaker. Une cote illisible ou ≤ 1 est écartée, jamais complétée. Chaque champ est converti seulement s’il a le type attendu (chaîne, nombre) : un champ d’un autre type (par exemple `fixture.date: {"toString": null}`) devient `null` ou écarte la valeur, sans exception. Aucune clé, aucune identité de visiteur.

Bornes :

| Borne                              | Valeur          | Effet                                                                     |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------- |
| Écritures par (match, `update`)    | 1               | ensemble mémoire + `put` conditionnel `If-None-Match: *` (entre serveurs) |
| Taille d’un objet                  | 32 768 octets   | derniers bookmakers retirés, `truncated: true`                            |
| Bookmakers / valeurs par marché    | 40 / 40         | au-delà : comptés dans `droppedBookmakers` ou ignorés                     |
| Matchs par réponse                 | 100             | au-delà : comptés `skipped`                                               |
| Attente de l’analyse sur l’archive | 0               | écriture en tâche de fond (`waitUntil`), voir ci-dessous                  |
| Durée d’une tâche d’archive        | 2 s par réponse | au-delà : la tâche se termine, compté `timeouts`                          |

Panne : aucune exception ne sort de l’archive. Une écriture refusée, une ligne qui lève pendant sa construction ou une réponse illisible est journalisée (`console.warn`, type d’erreur seulement) et comptée ; les autres lignes de la même réponse sont archivées normalement. `/api/diagnostics` expose `oddsArchive` : `responses`, `written`, `duplicates`, `truncated`, `skipped` (ligne sans identifiant, relevé ou cote exploitable), `rejected` (ligne qui a levé une exception), `failures`, `timeouts`, `lastFailureAt` (portée : isolat, comme `cache`). Aucune valeur de requête, de réponse ni de configuration n’y figure.

Hors du chemin critique : `api()` n’attend jamais l’archive. Les relevés sont construits à partir de la réponse dès sa réception, puis les écritures R2 continuent en tâche de fond. `fetch(req, env, ctx)` (`src/server/app.js`) attache le contexte d’exécution à `env` par `withExecutionContext` (propriété non énumérable, signatures des modules inchangées) ; `api()` confie alors la tâche à `ctx.waitUntil`, qui garde le Worker en vie jusqu’à la fin de l’écriture sans retarder la réponse. Sans contexte (Node, tests), la promesse est détachée et ses erreurs absorbées. Mesure (`tests/odds-archive.mjs` §8, délai réel de 2 s) : réponse HTTP en quelques millisecondes avec R2 sain, avec un `put` bloqué jusqu’à la fin de la réponse, et avec un `put` qui ne répond jamais ; avant la correction, 2 004 ms avec le `put` bloqué.

Preuve : `tests/odds-archive.mjs` (2 relevés → 2 objets, rejeu identique et succès de cache → 0, même nombre de requêtes avec ou sans archive, panne ou blocage R2 → ticket identique, `put` bloqué → aucune latence, coup d’envoi présent puis absent puis déplacé → 1 écriture, ligne mal formée → réponse et autres lignes intactes, plafond en octets avec 40 bookmakers × 4 marchés × 40 valeurs multioctets → 1 bookmaker gardé, 39 retirés) ; `tests/full-universe.mjs` affiche toujours `Requests: 20`.

## 2. Limite de l’archive seule

L’archive ne garde que ce que l’analyse a demandé, au moment où quelqu’un l’a lancée. Un match analysé à 9 h pour un coup d’envoi à 21 h n’a pas de relevé proche de la clôture. Le CLV (issue suivante) exige le dernier relevé avant le coup d’envoi, d’où la partie 3.

## 3. Capter la cote de clôture : options et coût

Notations : `N` = matchs du périmètre habituel sur une journée GMT−5, `M` = matchs ayant des cotes chez le fournisseur ce jour-là (toutes ligues), `p` = matchs par page de `odds?date` (10 selon la documentation API-Football, à vérifier sur une réponse réelle via `paging`), `s` = 6,5 s d’espacement de la file partagée.

### Option A — déclencheur planifié, `odds?fixture=<id>` près du coup d’envoi (recommandée)

Un déclencheur `scheduled` du Worker toutes les 5 minutes sélectionne les matchs du périmètre dont le coup d’envoi tombe dans une fenêtre `[T−45 min ; T−5 min]` et pas encore captés, puis appelle `odds?fixture=<id>` pour chacun, par la même fonction `api()`. Le relevé est archivé par la partie 1, sans code d’archive supplémentaire.

Calendrier : **il ne vient pas gratuitement du cache actuel.** `fixturesForDay` lit `fixtures?date` (J et J+1) avec un cache de **5 minutes** (`src/server/provider.js`). Un déclencheur toutes les 5 minutes qui l’appellerait tel quel referait ces 2 appels à presque chaque passage, soit jusqu’à 2 × 288 = 576 appels par jour. L’option A suppose donc un calendrier quotidien conservé explicitement : le déclencheur lit `fixtures?date` avec une durée de validité longue (paramètre `ttl` de `api()`, cache R2 partagé entre serveurs), rafraîchie `R` fois par jour pour suivre les reports. Hypothèse retenue : `R = 4` (validité 6 h), soit 2 × 4 = 8 appels par jour. Les passages entre deux rafraîchissements ne font aucun appel de calendrier ; un coup d’envoi déplacé après le dernier rafraîchissement est rattrapé par le `fixture.date` de la réponse `odds`, jamais deviné.

Coût par jour :

```
C_A = N × k × (1 + r) + 2 × R
  k = captures par match (recommandation k = 1)
  r = part des captures à reprendre (refus du fournisseur, file pleine) ; nominal r = 0
  R = rafraîchissements du calendrier par jour (hypothèse R = 4)
```

Un refus local `API_QUEUE_BUSY` ne consomme aucun appel ; une réponse 429 ou une erreur du fournisseur peut en consommer un, d’où `r`. Une capture reprise ne l’est qu’aux passages suivants dans la même fenêtre (au plus 8), jamais après le coup d’envoi. Ces appels s’ajoutent à ceux des analyses lancées par les visiteurs, qui partagent le même quota et la même file : le quota disponible pour la capture est `Q − C_analyses`, à lire sur `/api/status`.

| Périmètre N | Appels/jour (k = 1, r = 0, R = 4) | Occupation de la file (C_A × 6,5 s) | Part d’un quota de 7 500/jour | Part de 100/jour |
| ----------- | --------------------------------- | ----------------------------------- | ----------------------------- | ---------------- |
| 21          | 29                                | 3 min 9 s                           | 0,4 %                         | 29 %             |
| 50          | 58                                | 6 min 17 s                          | 0,8 %                         | 58 %             |
| 100         | 108                               | 11 min 42 s                         | 1,4 %                         | > 100 % ⚠        |
| 300         | 308                               | 33 min 22 s                         | 4,1 %                         | > 100 % ⚠        |

Vérification : 100 × 1 × (1 + 0) + 2 × 4 = 108 appels ; 108 × 6,5 s = 702 s = 11 min 42 s ; 108 / 7 500 = 1,44 %. Avec 10 % de reprises (`r = 0,1`) : 100 × 1,1 + 8 = 118 appels, 1,6 %. `N = 21` est le périmètre du test `full-universe` ; le périmètre réel se lit dans les analyses (`prepared.ids.length`). Les quotas 100 et 7 500 sont les offres publiques gratuite et « Pro » d’API-Football, donnés à titre d’exemple ; l’abonnement réel se lit sur `/api/status` (`subscription`, `requests`).

Impact sur la file partagée : `reserveProviderSlot` refuse (`API_QUEUE_BUSY`) un créneau réservé plus de 60 s à l’avance. Sur une file **vide**, un passage tient en `60 s / 6,5 s` ≈ 9 appels ; **8 appels (52 s) est un plafond nominal, pas une garantie.** Si la file est déjà occupée par une analyse, la capacité restante est `floor((60 s − b) / 6,5 s) + 1` appels pour un arriéré `b` : avec `b = 50 s`, seulement 2 réservations passent, puis `API_QUEUE_BUSY` (mesuré par le relecteur). Le déclencheur doit donc, avant chaque appel, lire `api-control/next-slot.json` et s’arrêter dès que l’arriéré dépasse 2 créneaux (13 s), pour laisser la place aux visiteurs ; les captures restantes sont reportées au passage suivant (5 min plus tard, toujours dans la fenêtre), et une capture refusée n’est jamais remplacée par une valeur inventée. Capacité nominale : 8 appels × 8 passages dans la fenêtre de 40 min = 64 matchs par créneau de coup d’envoi, moins ce que les analyses occupent. Pic typique : une quarantaine de matchs à la même heure le samedi, donc couvert ; au-delà, les matchs les plus proches du coup d’envoi passent d’abord et le reste est compté comme manqué, jamais inventé. Si le fournisseur demande une pause, le déclencheur s’arrête jusqu’au passage suivant (pause commune déjà gérée par `api-control/cooldown.json`).

### Option B — déclencheur planifié, pages `odds?date`

Un passage complet coûte `ceil(M / p)` appels, quel que soit le périmètre. Pour une précision de 15 minutes autour de chaque coup d’envoi, il faut un passage toutes les 15 minutes pendant les heures de match (environ 12 h) :

```
C_B = 48 × ceil(M / p)        ex. M = 400, p = 10 → 48 × 40 = 1 920 appels/jour
```

Chaque passage occupe la file `40 × 6,5 s = 4 min 20 s`, au-delà de la borne de 60 s : il faudrait le découper. Option écartée sauf si `N` approche `M`.

### Option C — relevé à la demande seulement

Ne rien planifier : on garde l’archive de la partie 1 et on ajoute un bouton ou une analyse lancée près du coup d’envoi. 0 appel automatique, mais la couverture de clôture dépend des visiteurs : inutilisable pour mesurer un CLV sans biais de sélection.

### Recommandation chiffrée

1. **Maintenant, 0 appel** : laisser tourner l’archive une à deux semaines et mesurer, par match, l’écart `kickoff − update` des relevés et l’intervalle entre deux `update` successifs. La documentation publique d’API-Football annonce des cotes rafraîchies par intervalles de plusieurs heures (à vérifier) : si c’est le cas, un relevé à T−45 min vaut déjà la « dernière cote » disponible chez ce fournisseur, et c’est la limite à écrire dans le calcul du CLV.
2. **Puis, sur décision du responsable** : option A, `k = 1`, déclencheur toutes les 5 minutes, fenêtre `[T−45 ; T−5]`, calendrier quotidien conservé et rafraîchi 4 fois par jour, au plus 8 appels par passage et arrêt dès que la file dépasse 13 s d’arriéré. Coût attendu `N × (1 + r) + 8` appels par jour, soit 108 pour 100 matchs sans reprise (1,4 % d’un quota de 7 500), et au plus 52 s d’occupation de la file par passage sur une file vide. Le déploiement d’un déclencheur `scheduled` relève de l’humain.
3. À ne pas faire : l’option A sur un quota de 100 appels par jour dès que `N` dépasse environ 50, car l’analyse elle-même consomme le reste du quota.
