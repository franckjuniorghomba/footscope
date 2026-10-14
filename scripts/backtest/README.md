# Banc temporel BIS-167, sans cotes

Node.js 24, aucune dépendance supplémentaire. Le banc est indépendant du Worker
et ne lit aucun secret du disque. Il n'accède jamais à R2 ou à une base de production.

## Démonstration et rapport

Depuis la racine du checkout :

```sh
node scripts/backtest/run.mjs \
  --input tests/fixtures/backtest-demo.json \
  --out "$JARVIS_LIVRABLES/demo"
```

Si `JARVIS_LIVRABLES` n'est pas configurée, la définir sans clé :

```sh
export JARVIS_LIVRABLES=/root/.local/share/jarvis/livrables/footscope/BIS-167
```

Le jeu de quarante rencontres de quatre équipes est **entièrement synthétique**.
Il démontre les métriques, les pertes, le bootstrap et le parcours logiciel ; il
ne constitue aucune preuve de performance réelle. Les sorties hors dépôt sont
`report.json` (dont prédictions et tickets), `rapport-backtest.md` et
`calibration.svg`. Le JSON inclut les sommes SHA-256 de l'entrée et du plan,
la durée locale et la mémoire de pointe. Tous les matchs du périmètre sont parcourus.

## Commande à lancer par l'humain pour les résultats historiques

La clé doit être fournie à `API_FOOTBALL_KEY` par l'environnement sécurisé, sans
l'inscrire dans un fichier ni la saisir dans une commande conservée dans l'historique.
Ne pas afficher la clé. Le plan est fixé dans `plan.json` : dix premières divisions,
saisons 2023, 2024, 2025, développement 2024/25, test 2025/26.

```sh
export BACKTEST_BUDGET_FILE="$JARVIS_LIVRABLES/budget-api-football.json"
# Une seule fois, uniquement pour une première collecte sans appels antérieurs :
node scripts/backtest/budget.mjs --used 0 --reason "Première collecte autorisée BIS-167"
node scripts/backtest/collect.mjs --out "$JARVIS_LIVRABLES/api-football"
node scripts/backtest/run.mjs \
  --input "$JARVIS_LIVRABLES/api-football/dataset.json" \
  --out "$JARVIS_LIVRABLES/historical"
```

Sans registre initialisé ou sans clé, le collecteur échoue avant tout appel. Un abonnement dont
la couverture n'inclut pas ces saisons peut également refuser la collecte. Il faut
alors signaler ce refus, sans annoncer de résultat prédictif ni acheter de données.

Un appel `fixtures?league=…&season=…` par couple, **trente tentatives maximum**,
espacées de 6,5 secondes. Aucun autre endpoint, aucun appel par match, aucune
pagination supplémentaire et aucun retry automatique. Le registre global
réserve la tentative avant le réseau (écriture atomique et synchronisation disque) ; un timeout, un refus ou une interruption
consomment donc leur tentative. Les erreurs et corps de réponse ne sont pas
recopiés dans les journaux. Les données conservées se limitent aux identifiants,
équipes, date, ligue, statut et score publics des rencontres.

Le registre unique est choisi par `BACKTEST_BUDGET_FILE`, sinon
`$JARVIS_LIVRABLES/budget-api-football.json`, sinon le chemin fixe
`/root/.local/share/jarvis/livrables/footscope/BIS-167/budget-api-football.json`.
Il doit être **hors de tout dossier `--out`**. Toutes les collectes de ce budget
doivent utiliser ce même fichier partagé, y compris depuis d'autres checkouts.
Changer `--out` ou supprimer `collection.json` ne restitue aucune tentative.
Le registre absent (même avec un cache existant), illisible ou incohérent provoque
un refus ; le collecteur ne crée jamais de compteur à zéro automatiquement.
Le verrou exclusif `<registre>.lock` est tenu pendant toute la collecte : une
seconde collecte simultanée est refusée, même avec une autre sortie. L'espacement
de 6,5 secondes utilise la dernière réservation globale. La coordination exige
un même système de fichiers avec création exclusive et renommage atomique ;
des registres sur des machines indépendantes ne partagent pas ce budget.

Conserver le journal et les caches : la relance réutilise les fichiers terminés
après vérification SHA-256, même sans clé. Une
réponse en erreur ou paginée, une somme différente ou un couple déjà tenté sans
cache arrête la collecte pour examen manuel ; ne pas effacer son entrée pour
réessayer. Après un arrêt brutal, vérifier que le processus est terminé avant de
retirer manuellement `collect.lock` et `<registre>.lock`. Ne pas lancer simultanément une autre collecte
payante avec la même clé ; la coordination des appels du Worker demeure inchangée.

## Période test neuve : saison 2026/27 (BIS-185)

`plan-2026.json` est un second plan figé : les dix mêmes ligues, saison 2026
seulement, soit **dix couples et dix appels au plus**. Il n'est utilisé que si
`--plan` est passé explicitement au collecteur. Sans `--plan`, le collecteur
utilise `plan.json`, avec le même `planHash` (`f41afaad…`) et le même jeu.
Le plan 2026 a son propre `planHash`, et donc son propre journal, dans son propre
dossier `--out`. Il ne touche jamais au jeu 2023-2025, dont il épingle la somme
(`history.sha256 = 7101245773e9…`) et le plan.

`testEnd` vaut `collection-day` : le collecteur écrit dans `dataset.json` la date
de la **première** tentative de son journal (`collection.collectedAt`) et la
journée GMT−5 correspondante (`collection.testEnd`, exclue). Seules les journées
antérieures, complètes dans chaque fichier, sont évaluées. La date ne bouge pas lors
d'une reprise depuis le cache. Les statuts collectés sont comptés
(`collection.statuses`). Les matchs non joués (NS…) et ceux de la journée de
collecte ou d'après ne sont ni évalués ni appris. Leur nombre figure dans
`coverage.afterTestEnd` ; les non-FT antérieurs sont exclus avec le motif `non_final`.

`coverage.afterTestEnd` (`{ count, byStatus }`) est un champ **ajouté** à tous les
rapports, y compris celui du plan par défaut. Il compte, par statut, les rencontres
datées de `testEnd` ou après. Pour le jeu BIS-167 (`7101245773e9…`), il vaut
`{ "count": 0, "byStatus": {} }`. Les autres champs, statistiques, prédictions et
tickets restent identiques, hors `elapsedMs` et `maxRssKiB`. Un lecteur de l'ancien
format peut l'ignorer.

Limite de collecte et périmètre d'analyse sont distincts. Un plan de collecte
demande au plus 30 couples (`MAX_CALLS`, inchangé) et seul le registre autorise
les appels. Le plan combiné par `run.mjs --history` (dix ligues × 2023-2026, soit
40 couples) n'est accepté que par le runner, après vérification des sommes de
collecte des deux jeux ; il ne déclenche aucun appel.

### Commande à lancer par l'humain (autorisation de dix appels)

Le registre partagé est plein (30/30). Il n'est jamais remis à zéro
automatiquement : l'humain l'archive, puis l'initialise à `--used 20`, ce qui
permet exactement dix appels. Depuis la racine du checkout :

```sh
export BACKTEST_BUDGET_FILE=/root/.local/share/jarvis/livrables/footscope/BIS-167/budget-api-football.json
export JARVIS_LIVRABLES=/root/.local/share/jarvis/livrables/footscope/BIS-185
ARCHIVE=/root/.local/share/jarvis/livrables/footscope/BIS-167/budget-api-football-bis167-30-appels.json
# Sous-shell à arrêt immédiat : le premier échec arrête tout, avant saisie et réseau.
# La clé n'existe que dans ce sous-shell ; son code de sortie reste dans $?.
(
  set -eu
  # 1. Aucun collecteur actif, aucun verrou, archive absente.
  if pgrep -f '[s]cripts/backtest/collect.mjs' >/dev/null; then
    echo 'Collecteur actif : arrêt, aucune modification.' >&2
    exit 1
  fi
  test ! -e "$BACKTEST_BUDGET_FILE.lock"
  test ! -e "$ARCHIVE"
  # 2. Archiver (déplacement, sans suppression) puis initialiser au même chemin.
  mv -n "$BACKTEST_BUDGET_FILE" "$ARCHIVE"
  test -e "$ARCHIVE"
  test ! -e "$BACKTEST_BUDGET_FILE"
  node scripts/backtest/budget.mjs --used 20 \
    --reason "BIS-185 : 10 appels autorisés pour la saison 2026 ; registre précédent archivé (30/30)"
  # 3. Clé saisie sans écho, jamais dans l'historique ni dans un fichier ; vide = arrêt.
  read -rsp 'Clé API-Football : ' API_FOOTBALL_KEY
  echo >&2
  test -n "$API_FOOTBALL_KEY"
  export API_FOOTBALL_KEY
  node scripts/backtest/collect.mjs --plan scripts/backtest/plan-2026.json \
    --out "$JARVIS_LIVRABLES/api-football-2026"
)
```

Le bloc entier est une seule unité. Il s'arrête avec un code non nul, **sans aucun
appel**, si un collecteur est actif, si un verrou ou l'archive existe, si le
déplacement ou l'initialisation échoue, ou si la saisie de clé échoue ou est vide.
L'archive existante n'est jamais écrasée. La clé disparaît avec le sous-shell, que
la collecte réussisse ou non ; `echo $?` donne ensuite le code du premier échec.
Après un arrêt à l'étape 3, ne pas relancer ce bloc : l'archive existe et il
refuserait. Relancer seulement l'étape 3 dans un sous-shell, avec la même commande
`collect.mjs`.

La sortie JSON donne le nombre d'appels, la somme du jeu, `testEnd` et les statuts.
Une interruption se reprend par la même commande `collect.mjs` (cache vérifié,
sans nouvelle initialisation). Un refus du fournisseur (abonnement sans la saison
2026, réponse vide ou paginée) consomme sa tentative et doit être signalé tel quel,
sans annoncer de résultat. Après cette initialisation, l'ancien dossier
`api-football` ne peut plus être _recollecté_ (son journal est absent du nouveau
registre). Le runner continue de le lire, car il vérifie seulement ses sommes.

### Évaluer la période neuve (seulement après le gel de la marge BIS-184)

Ne lancer qu'une fois la marge de prudence BIS-184 figée : la période neuve ne
doit être lue qu'une fois.

```sh
node scripts/backtest/run.mjs \
  --input "$JARVIS_LIVRABLES/api-football-2026/dataset.json" \
  --history /root/.local/share/jarvis/livrables/footscope/BIS-167/api-football/dataset.json \
  --out "$JARVIS_LIVRABLES/historical-2026"
```

`--history` est obligatoire pour un jeu à période neuve, et refusé sinon. Le runner
vérifie les deux sommes de collecte, puis que l'historique est bien celui épinglé par
le plan (somme et `planHash`). Il vérifie aussi les ligues identiques, les saisons
disjointes et l'absence de rencontre de l'historique à partir de `testStart`. Il
contrôle la date de collecte et refuse toute rencontre présente dans les deux jeux.
Le plan résolu couvre les saisons 2023 à 2026 : développement (choix de ξ et ridge
Dixon-Coles) du 2025-07-01 au 2026-06-30, puis test du 2026-07-01 à `testEnd`.
L'apprentissage reprend tout l'historique antérieur, journée par journée. Le
rapport cite les deux sommes dans `sources`.

Retour arrière : aucune migration ni donnée de production. Pour revenir à l'état
antérieur, arrêter le collecteur. Déplacer ensuite le nouveau registre vers une
seconde archive, sans le supprimer, puis remettre l'archive 30/30 à sa place. Le
budget redevient alors plein, ce qui reste plus restrictif. Le jeu 2023-2025 n'est
jamais modifié.

### Initialisation, reprise des anciens caches et réinitialisation

`budget.mjs --used N --reason "motif écrit sans secret"` est une action manuelle
explicite. Elle refuse d'écraser un registre existant. `--used` représente les
appels déjà consommés avant son installation, en plus des futures réservations.
**Avec d'anciens caches/journaux, ne jamais initialiser à zéro** : auditer tous les
dossiers et toutes les tentatives, y compris les échecs, puis renseigner ce total.
Si le total est inconnu, initialiser avec `--used 30` : aucun nouveau réseau ne
sera permis. Les anciens caches vérifiés restent lisibles si leur nombre de
tentatives est couvert par ce solde initial. Un journal manquant demande un
examen manuel, sans nouvelle collecte pour recréer ses fichiers.

Une remise à zéro exige une **nouvelle autorisation budgétaire écrite du responsable**.
Arrêter les collecteurs, vérifier l'absence de processus et de verrou actif,
archiver le registre avec ses journaux/caches (sans les supprimer), puis exécuter
explicitement l'initialisation `--used 0 --reason "Référence de la nouvelle autorisation"`
au **même chemin**. Archiver par exemple le registre par un déplacement vers
`budget-api-football-budget-precedent.json` hors `--out`, après avoir vérifié que
cette archive n'existe pas. Changer `BACKTEST_BUDGET_FILE`, effacer le registre,
modifier ses réservations ou enlever un verrou actif ne constitue pas une reprise.
Un registre corrompu doit être restauré depuis son archive ou remplacé après audit
avec `--used 30` si l'historique des appels ne peut pas être établi.

Le collecteur fige `dataset.json`, `dataset-checksum.json`, les trente fichiers de
résultats normalisés et le journal. Le runner vérifie aussi la somme du jeu
historique et de son plan avant de calculer. Ces fichiers restent hors Git. Une relance
terminée produit le même jeu et la même somme, sans appel supplémentaire. Une
rencontre dupliquée, un statut FT sans score ou un périmètre incomplet sont des erreurs.

## Sélection Dixon-Coles − m contre sélection actuelle (BIS-184)

`selection.mjs` compose, sur les mêmes journées et avec le même `selectCouponDetailed`,
deux tickets par journée : (A) la sélection actuelle, jambe si probabilité Poisson ≥ 0,7
et historique récent, annoncé = probabilité prudente ; (B) jambe si probabilité
Dixon-Coles ≥ 0,7 et historique récent, annoncé = max(0, p − m). Produit ≥ 0,5,
un pari par match, quatre jambes au plus. A recomposée doit égaler le ticket du
moteur, sinon la comparaison est refusée. Les lignes de prévision gagnent deux
champs additifs, `recentHistory` et `kickoff`, et `runBacktest` accepte
`dixonColesChosen` pour figer (ξ, ridge).

La marge m suit une règle écrite avant tout calcul (`MARGIN_RULE`) : grille 0 à
0,20 par pas de 0,01 ; plus petit m pour lequel, sur 2024/25, l'annoncé moyen des
tickets B est ≤ au passage observé, au total et pour chaque taille d'au moins 30
tickets. (ξ, ridge) sont ceux du run 2026/27, choisis sur 2025/26 avec l'historique
seul. Trois étapes, dans cet ordre :

```sh
H=/root/.local/share/jarvis/livrables/footscope/BIS-167/api-football/dataset.json
OUT=/root/.local/share/jarvis/livrables/footscope/BIS-184
# 1. Gel sur 2024/25 (le fichier de paramètres est créé une seule fois, puis committé).
node scripts/backtest/margin.mjs freeze --history "$H" --params scripts/backtest/margin-2026.json
SHA=$(sha256sum scripts/backtest/margin-2026.json | cut -d' ' -f1)
# 2. Contrôle 2025/26, saison déjà lue par BIS-167 et BIS-183.
node scripts/backtest/margin.mjs control --history "$H" \
  --params scripts/backtest/margin-2026.json --params-sha "$SHA" --out "$OUT"
# 3. Lecture unique de 2026/27 : le témoin lecture-2026-27.json refuse toute relance.
node scripts/backtest/margin.mjs evaluate --history "$H" \
  --input /root/.local/share/jarvis/livrables/footscope/BIS-185/api-football-2026/dataset.json \
  --params scripts/backtest/margin-2026.json --params-sha "$SHA" \
  --control "$OUT/controle-2025-26.json" --out "$OUT"
```

Le gel a été fait le 2026-10-14 : **m = 0,03**, `margin-2026.json` SHA-256
`9f912a82…`. Mesures : gel 44 s et 242 Mio de RSS, contrôle 10 s, évaluation
7 s et 182 Mio. **La période 2026/27 a été lue par l'étape 3** ; toute nouvelle
lecture, y compris par `run.mjs --history`, n'est plus un test intact.

Le verdict par taille est mécanique : « annoncé fiable » si l'IC à 95 % de
(observé − annoncé) contient 0 et |écart| < 5 points ; sinon « optimiste » ou
« pessimiste » ; « non défini » sous deux tickets. L'IC est un bootstrap par
ticket (un ticket par journée). Sous 30 tickets, il est peu fiable : avec quatre
tickets tous gagnés, il est étroit à tort. Ce rapport ne dit rien du rendement.

## Interpréter les chiffres

Les probabilités utilisent `assessMatch` et `eventProbability`, avec la même
sensibilité que `poisson-sensitivity-v1` (parité couverte par les tests). Les dix
événements fixés sont 1X2, Over/Under 2.5, BTTS et les trois doubles chances.
Brier, log-loss binaire et calibration sont calculés pour tous les événements
évaluables, puis séparément pour les sélections retenues. Les IC utilisent les
journées GMT−5 comme grappes et les différences Poisson − naïf sont appariées.

Les tickets sont une **composition de recherche sans prix**, conditionnelle aux
seuls critères de probabilité/historique disponibles. `selectCouponDetailed` est
réutilisé directement ; seuil combiné de 0,5, quatre événements au plus, un par
match. Un groupe de recherche unique remplace uniquement le regroupement par
bookmaker. Les timestamps internes désignent l'instant du calcul, pas un relevé
de cotes. Aucun prix, avantage ou preuve d'effectif n'est inventé.

Ce résultat ne reproduit pas l'admission complète du moteur : edge, fraîcheur et
disponibilité des cotes, absences et compositions ne sont pas vérifiables. La
référence naïve (fréquences passées de ligue avec Laplace) prédit les mêmes jambes
que Poisson ; on compare leur calibration, pas deux taux de passage issus de
populations différentes. Le rendement et la comparaison au marché sans marge
sont reportés. football-data.co.uk est exclu et aucune source alternative n'est
actuellement autorisée. `modelValidated` et `realMoneyEligible` restent faux.

## Modèle Dixon-Coles (BIS-183, banc uniquement)

`dixon-coles.mjs` ajoute une colonne `dixon-coles` à tous les tableaux, sans rien
changer en production (`statistics.js`, `policy.js` et le Worker sont intacts).
Par ligue : intercept, avantage du terrain, attaque et défense par équipe, avec
Σattaques = Σdéfenses = 0, et correction ρ des seuls scores 0-0, 1-0, 0-1, 1-1
(|ρ| ≤ 0,2). Maximum de vraisemblance pondéré par `exp(−ξ × âge en jours)`,
L-BFGS déterministe, départ à chaud depuis l'ajustement précédent de la ligue.

- **Anti-fuite** : réajustement au plus une fois par ligue et par journée GMT−5,
  avec les seuls matchs FT des journées strictement antérieures ; prédire après
  avoir appris le jour même lève une erreur.
- **Rétrécissement** : pénalité ridge `½ × ridge × Σ(attaque² + défense²)`, prior
  centré sur la moyenne de la ligue. Une équipe promue reste près de la moyenne
  jusqu'à ce que ses matchs l'en écartent ; les prédictions avec une équipe sous
  19 matchs de ligue sont comptées. Une rencontre sans prédiction Dixon-Coles est
  exclue pour tous les modèles, avec son motif (`dixon_coles_*`).
- **Choix de ξ et ridge** : grille fixe ξ ∈ {0 ; 0,001 ; 0,002 ; 0,004} × ridge ∈
  {1 ; 4 ; 16}, critère = moyenne des Brier 1X2, Plus/moins 2,5 et BTTS sur la
  saison de développement. Seules les rencontres antérieures à `testStart` sont
  transmises au choix ; la saison test est lue une fois avec les paramètres figés.
- **Verdict** par marché : « meilleur » si la différence de Brier Dixon-Coles −
  Poisson est négative et que son IC apparié à 95 % (bootstrap par journée) exclut
  0, « pire » symétriquement, sinon « indistinct ». ECE = écart pondéré des classes
  de calibration de 0,1. Dixon-Coles est évalué sur les jambes choisies par le
  sélecteur Poisson ; il ne compose pas ses propres tickets.

Durée mesurée sur le jeu historique BIS-167 (9 824 rencontres, 12 points de grille
puis passe finale) : environ 45 s et 380 Mio de RSS. Un verdict « meilleur » ne
valide pas le modèle : sa mise en production reste une décision du responsable.

## Validation et retour arrière

```sh
npm ci
node tests/backtest.mjs
node tests/dixon-coles.mjs
node tests/backtest-2026.mjs
node tests/margin.mjs
npm run check
```

Les tests n'utilisent ni réseau réel ni clé réelle. `npm run check` doit aussi
réussir sur un checkout propre : les prompts locaux `.workmux/PROMPT-*.md` ne font
pas partie du code et ne doivent pas être modifiés pour corriger leur format.

Aucune migration SQL : retrait possible des scripts et de l'ADR, conservation des
jeux, rapports et registre global hors dépôt pour audit. Suspendre la collecte si
le correctif est retiré : ne pas relancer l'ancien collecteur qui ne protège pas
le budget global. Aucune table, colonne ou donnée de production
n'est touchée. Voir `docs/adr/0001-backtest.md` pour les limites scientifiques et
les futures décisions de sources.
