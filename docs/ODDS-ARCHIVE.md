# Archive des cotes et cote de clôture

Statut : l’archive (parties 1 et 2) est en place ; la capture de clôture (partie 3) n’est **pas activée**. Ce document la cadre seulement : il n’ajoute aucun déclencheur ni aucun appel. L’activer coûte des appels API, la décision revient au responsable.

## 1. Archive des relevés déjà reçus (0 appel en plus)

`api()` (`src/server/provider.js`) appelle `archiveOdds()` (`src/server/odds-archive.js`) **uniquement** après une réponse réseau réussie d’un chemin `odds?…`. Les succès de cache (mémoire, R2), les rattachements à une requête en cours, les erreurs et les pauses du fournisseur n’arrivent jamais à l’archive. Le cache, l’espacement de 6,5 s, la file partagée `api-control/` et les compteurs de `/api/diagnostics.cache` ne changent pas.

Clé : `odds-archive/<AAAA-MM-JJ>/<fixtureId>/<update>.json`, où le jour est celui du coup d’envoi en GMT−5 fixe (celui du relevé si le coup d’envoi manque) et `<update>` l’horodatage `update` du fournisseur au format ISO compact (`20261014T135650592Z`).

Contenu (version 1) : `fixtureId`, `league` (id, nom, pays, saison), `kickoff`, `update`, `retrievedAt`, `query` (chemin fournisseur, sans clé), `truncated`, `droppedBookmakers` et `bookmakers[]` → `{ id, name, markets[] → { name, values[] → { value, odd } } }`. Seuls les marchés gérés sont gardés (`Match Winner`, `Double Chance`, `Goals Over/Under`, `Both Teams Score`), une fois chacun par bookmaker. Une cote illisible ou ≤ 1 est écartée, jamais complétée. Aucune clé, aucune identité de visiteur.

Bornes :

| Borne                              | Valeur          | Effet                                                                     |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------- |
| Écritures par (match, `update`)    | 1               | ensemble mémoire + `put` conditionnel `If-None-Match: *` (entre serveurs) |
| Taille d’un objet                  | 32 768 octets   | derniers bookmakers retirés, `truncated: true`                            |
| Bookmakers / valeurs par marché    | 40 / 40         | au-delà : comptés dans `droppedBookmakers` ou ignorés                     |
| Matchs par réponse                 | 100             | au-delà : comptés `skipped`                                               |
| Attente de l’analyse sur l’archive | 2 s par réponse | au-delà : l’analyse continue, compté `timeouts`                           |

Panne : une écriture refusée est journalisée (`console.warn`, type d’erreur seulement) et comptée. `/api/diagnostics` expose `oddsArchive` : `responses`, `written`, `duplicates`, `truncated`, `skipped`, `failures`, `timeouts`, `lastFailureAt` (portée : isolat, comme `cache`). Aucune valeur de requête ni de configuration n’y figure.

Choix prudent : le Worker ne transmet pas encore de contexte d’exécution (`waitUntil`) jusqu’à `api()` ; l’écriture est donc attendue, bornée à 2 s, et ne rejette jamais. Une écriture R2 saine prend quelques dizaines de millisecondes, à comparer aux 6,5 s d’espacement entre deux appels.

Preuve : `tests/odds-archive.mjs` (2 relevés → 2 objets, rejeu identique et succès de cache → 0, même nombre de requêtes avec ou sans archive, panne ou blocage R2 → ticket identique, plafond de taille) ; `tests/full-universe.mjs` affiche toujours `Requests: 20`.

## 2. Limite de l’archive seule

L’archive ne garde que ce que l’analyse a demandé, au moment où quelqu’un l’a lancée. Un match analysé à 9 h pour un coup d’envoi à 21 h n’a pas de relevé proche de la clôture. Le CLV (issue suivante) exige le dernier relevé avant le coup d’envoi, d’où la partie 3.

## 3. Capter la cote de clôture : options et coût

Notations : `N` = matchs du périmètre habituel sur une journée GMT−5, `M` = matchs ayant des cotes chez le fournisseur ce jour-là (toutes ligues), `p` = matchs par page de `odds?date` (10 selon la documentation API-Football, à vérifier sur une réponse réelle via `paging`), `s` = 6,5 s d’espacement de la file partagée.

### Option A — déclencheur planifié, `odds?fixture=<id>` près du coup d’envoi (recommandée)

Un déclencheur `scheduled` du Worker toutes les 5 minutes sélectionne les matchs du périmètre dont le coup d’envoi tombe dans une fenêtre `[T−45 min ; T−5 min]` et pas encore captés, puis appelle `odds?fixture=<id>` pour chacun, par la même fonction `api()`. Le relevé est archivé par la partie 1, sans code d’archive supplémentaire. Le calendrier vient des `fixtures?date` du jour, déjà en cache quand une analyse a tourné ; sinon 2 appels par jour (jour J et J+1, comme `fixturesForDay`).

Coût par jour :

```
C_A = N × k + 2        (k = captures par match ; recommandation k = 1)
```

| Périmètre N | Appels/jour (k = 1) | Occupation de la file (C_A × 6,5 s) | Part d’un quota de 7 500/jour | Part de 100/jour |
| ----------- | ------------------- | ----------------------------------- | ----------------------------- | ---------------- |
| 21          | 23                  | 2 min 30 s                          | 0,3 %                         | 23 %             |
| 50          | 52                  | 5 min 38 s                          | 0,7 %                         | 52 %             |
| 100         | 102                 | 11 min 3 s                          | 1,4 %                         | > 100 % ⚠        |
| 300         | 302                 | 32 min 43 s                         | 4,0 %                         | > 100 % ⚠        |

Vérification : 100 × 1 + 2 = 102 appels ; 102 × 6,5 s = 663 s = 11 min 3 s ; 102 / 7 500 = 1,36 %. `N = 21` est le périmètre du test `full-universe` ; le périmètre réel se lit dans les analyses (`prepared.ids.length`). Les quotas 100 et 7 500 sont les offres publiques gratuite et « Pro » d’API-Football, donnés à titre d’exemple ; l’abonnement réel se lit sur `/api/status` (`subscription`, `requests`).

Impact sur la file partagée : `reserveProviderSlot` refuse (`API_QUEUE_BUSY`) un créneau réservé plus de 60 s à l’avance. Un passage du déclencheur doit donc rester sous `60 s / 6,5 s` = **9 appels**, recommandation **8** (52 s), pour ne jamais faire refuser l’analyse d’un visiteur. Capacité : 8 appels × 8 passages dans la fenêtre de 40 min = 64 matchs par créneau de coup d’envoi. Pic typique : une quarantaine de matchs à la même heure le samedi, donc couvert ; au-delà, les matchs les plus proches du coup d’envoi passent d’abord et le reste est compté comme manqué, jamais inventé. Si le fournisseur demande une pause, le déclencheur s’arrête jusqu’au passage suivant (pause commune déjà gérée par `api-control/cooldown.json`).

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
2. **Puis, sur décision du responsable** : option A, `k = 1`, déclencheur toutes les 5 minutes, fenêtre `[T−45 ; T−5]`, au plus 8 appels par passage. Coût attendu `N + 2` appels par jour, soit 102 pour 100 matchs (1,4 % d’un quota de 7 500), et au plus 52 s d’occupation de la file par passage. Le déploiement d’un déclencheur `scheduled` relève de l’humain.
3. À ne pas faire : l’option A sur un quota de 100 appels par jour dès que `N` dépasse environ 50, car l’analyse elle-même consomme le reste du quota.
