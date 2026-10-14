# ADR 0001 — Banc temporel des sélections et tickets sans cotes

Statut : accepté pour BIS-167 selon la décision du chef du 14 octobre 2026.

## Problème et périmètre

`poisson-sensitivity-v1` ne possède aucune validation prédictive indépendante.
Le banc fournit des scores hors échantillon pour ses événements et une mesure du
passage des combinaisons. Les tests synthétiques vérifient le logiciel seulement.
`statistics.js`, `policy.js` et les drapeaux de validation restent inchangés.

La décision du chef remplace le volet de données initial : **aucune cote historique**,
aucune utilisation de football-data.co.uk et aucune autre source de cotes autorisée.
Les résultats proviennent exclusivement d'API-Football, trente appels maximum.
Sans clé dans le bac à sable, on livre collecteur, petite fixture synthétique et
commande exacte à lancer par l'humain ; aucune métrique réelle n'est inventée.

## Vérification de la source exclue et décisions futures

La [page des données football-data.co.uk](https://football-data.co.uk/data.php),
consultée le 14 octobre 2026, indique « private individuals only, NOT commerical or
data training products using automated bots/scrapers/AI ». L'accès gratuit ne
couvre donc pas l'usage commercial automatisé envisagé. Le responsable a décidé
l'exclusion de cette source. Aucun script n'accède à son domaine.

La [documentation des colonnes](https://football-data.co.uk/notes.txt) identifie
les clôtures par `C` (1X2 bet365 et totaux 2,5). La page des données annonce ces
relevés depuis 2019/20 et répertorie dix pays européens pertinents. Une sonde
structurelle E0 2023/24 avait montré 380 lignes renseignées pour ces cinq colonnes
avant découverte de la restriction ; cette sonde ne sert à aucun entraînement ou
backtest. Le fichier brut doit être isolé des livrables de travail dans la quarantaine
`BIS-167-quarantaine`. Une note hors dépôt conserve la provenance, la date, le SHA-256
et le constat. La suppression définitive revient à l'humain. La sonde ne prouve pas la
couverture des autres ligues.

La comparaison au marché sans marge et le rendement sont **reportés**, avec valeurs
nulles/absentes et motif explicite dans les rapports, plutôt qu'une cote supposée.
Options à décider par l'humain dans une issue ultérieure : contrat avec un
fournisseur de cotes historiques dont la licence couvre cet usage, ou archivage
prospectif des cotes et preuves avant match avec droits adaptés. Coût, couverture,
horaires de relevé et droits de redistribution devront être établis. Aucune de
ces options n'autorise un achat ou un appel de cotes dans BIS-167.

## Contrat de données et collecte

`plan.json` fige dix premières divisions (identifiants API 39, 179, 78, 135, 140,
61, 88, 144, 94, 203), saisons 2023/24, 2024/25, 2025/26. Ce sous-ensemble exclut
les coupes et divisions inférieures ; il ne prétend pas couvrir les dix derniers
matchs toutes compétitions d'une équipe. Tous les matchs reçus sont conservés.

Le jeu JSON version 1 contient `kind` (`historical` ou `demonstration`), `source`,
le plan et les fixtures API normalisées : identifiant, date UTC/timestamp, statut,
ligue/saison, identifiants et noms d'équipes, buts. Un FT nécessite deux buts
entiers non négatifs. Les identifiants doivent être uniques. Les statuts autres
que FT restent visibles dans la couverture mais ne sont ni appris ni réglés.
Aucune prolongation ou séance de tirs au but n'entre dans les résultats évalués.
Le collecteur n'utilise aucun résultat d'un autre fournisseur ni donnée client.

Un appel `fixtures` par ligue/saison, jamais par match ; cache et journal persistants
extérieurs au dépôt, registre de budget unique hors des sorties `--out`, verrou
global exclusif et verrou par dossier, intervalle de 6,5 secondes,
timeout de trente secondes, refus des redirections et arrêt sur erreur, réponse
vide/incohérente ou pagination. Chaque tentative est réservée avant le réseau,
y compris les refus et interruptions ; aucun retry automatique. Le budget global
de cette collecte unique est trente. `BACKTEST_BUDGET_FILE` choisit le registre,
sinon `$JARVIS_LIVRABLES/budget-api-football.json` ou le chemin fixe documenté dans
le README. Chaque réservation est synchronisée puis renommée atomiquement avant
le réseau. Le verrou global couvre toute la collecte et refuse un second processus,
même dans une autre sortie. Changement de sortie, suppression du journal et relance
ne restituent aucun appel. Un registre absent/illisible est un refus, même avec
cache. L'initialisation et la remise à zéro sont des actions explicites documentées ;
les anciens appels doivent être comptabilisés, et une nouvelle enveloppe nécessite
une autorisation écrite. La coordination repose sur un fichier partagé, pas sur
des registres indépendants par machine. Le Worker demeure inchangé.

`API_FOOTBALL_KEY` provient uniquement de l'environnement ; aucun secret du disque
n'est lu, aucun secret ou corps d'erreur fournisseur n'est affiché ou enregistré.
Une réponse réussie est normalisée, validée et munie de sa somme SHA-256. La relance
vérifie les caches et s'arrête sur corruption ou tentative consommée sans cache.
Le jeu final et son checksum sont figés dans les livrables. Le rapport identifie
l'entrée et le plan par leurs sommes et expose la couverture ligue/saison. Le
runner vérifie le checksum de collecte du jeu historique avant tout calcul. Le
runner refuse un jeu historique privé d'un couple prévu ; la présence d'un couple
ne prouve pas à elle seule l'exhaustivité du fournisseur. Le contrôle de couverture
réelle reste à faire après la collecte autorisée.

## Séparation temporelle et modèle

Passé initial : 2023/24. Développement : journées du 1er juillet 2024 inclus au
1er juillet 2025 exclu. Test : du 1er juillet 2025 inclus au 1er juillet 2026 exclu.
Bornes, événements, graine et réplications sont figés avant évaluation ; ne pas
changer les paramètres sur les résultats du test. La petite démonstration dispose
de son propre plan déclaré, sans prétendre représenter les saisons réelles.

Un snapshot est pris à minuit GMT−5 fixe sur chaque journée comportant des matchs.
Seuls les FT de journées strictement antérieures alimentent les historiques ;
aucun résultat du jour, même d'un match plus tôt dans la journée, n'est appris
avant l'ensemble des prédictions. Cette précaution couvre l'absence d'horaires de
fin. Les matchs exactement à l'instant du snapshot sont exclus et dénombrés.
Le statut cible est NS et son score est nul dans l'appel à `assessMatch`.

`assessMatch` calcule les lambdas avec ses huit antécédents minimum, dix maximum.
`eventProbability` calcule les dix événements fixés (1X2, Over/Under 2.5, BTTS,
double chance). L'enveloppe reprend les neuf facteurs 0,75/1/1,25 et la soustraction
de 0,05 de `poisson-sensitivity-v1`, sans changer le moteur ; un test vérifie la
parité numérique pour chaque événement. Cette enveloppe n'est pas un IC calibré.
Les snapshots rétrospectifs ne datent pas les corrections de scores du fournisseur.

La référence naïve utilise les fréquences passées de la ligue avec Laplace : trois
catégories pour le 1X2, deux pour les binaires, doubles chances par complément du
1X2 lissé. Son apprentissage suit exactement les mêmes bornes et journées.

## Tickets de recherche et admission de production

Sans cotes historiques, il est impossible de reproduire les critères d'edge,
disponibilité de marché et fraîcheur de cotes. Les absences et compositions
historiques ne sont pas collectées. Aucun de ces éléments manquants n'est inventé.
Les tickets mesurés sont explicitement **conditionnels aux seules probabilités**,
conformément au nouveau périmètre ; aucune admission de production n'en découle.

Le banc retient les événements avec probabilité exploratoire ≥ `POLICY.minProbability`
et un historique assez récent (≤ `POLICY.maxRecentAgeDays`). Il appelle directement
`selectCouponDetailed` pour les combinaisons, sans recopier BIS-176 ni desserrer son
seuil combiné de 0,5. Un événement par match, quatre au plus, un seul groupe de
recherche ; un ticket au plus par journée. Les égalités suivent l'ordre fixe des
événements et des fixtures (timestamp puis identifiant), jamais le résultat futur.

L'adaptateur interne fournit le statut attendu par le sélecteur, le groupe
`offline-unpriced`, les timestamps du calcul et un départage neutre `prudentEdge=0`.
Il s'agit exclusivement du transport vers une interface existante : aucun de ces
champs ne devient une cote, un avantage réel ou un bookmaker dans les sorties.
Les lignes exportées portent `researchCandidate`, les tickets le mode
`conditional_probability_only`. `modelValidated` et `realMoneyEligible` restent
faux. Le rapport distingue cette composition de l'admission complète et ne
transforme pas une absence de données fournisseur en « aucune sélection intéressante ».

## Mesures et limites

Par marché, tous les événements évaluables et séparément les sélections retenues :
Brier binaire moyen, log-loss binaire bornée à 10⁻¹², dix classes de calibration
fixes avec moyennes annoncées/observées et effectifs. Les trois doubles chances
se chevauchent ; le score est une moyenne binaire, pas une log-loss multiclasses.
La calibration est fournie dans le JSON, le Markdown et un SVG du test.

Par ticket : effectifs et tailles, journées sans ticket, taux de passage contre
produit des probabilités prudentes et exploratoires. La référence naïve prédit les
**mêmes jambes** : le passage observé est commun, les probabilités et leurs scores
permettent la comparaison. Il ne s'agit pas de deux stratégies de sélection.

IC percentile à 95 %, bootstrap des journées entières GMT−5 (2 000 réplications,
graine 167), en conservant les journées sans ticket. IC des scores par marché,
du taux de passage, des probabilités annoncées et de leurs écarts ; différences
Poisson − naïf appariées. Les tirages sans ticket produisent une valeur non définie,
exclue avec nombre de réplications valides exposé. Une seule journée ne produit
pas d'IC ; faibles effectifs et intervalles dégénérés restent signalés. Les
produits de probabilités supposent l'indépendance des jambes. Ce bootstrap ne
mesure pas l'incertitude due aux ligues, aux régimes temporels ou au choix du modèle.

L'historique disponible ne corrige pas la force des adversaires. Aucun réglage de
seuil, Dixon-Coles ou validation commerciale dans cette PR. Le rapport se termine
par cinq lignes accessibles et désigne clairement un jeu synthétique comme une
démonstration. Les scores hors échantillon réels restent indisponibles sans collecte.

## Validation, migration et retour arrière

Tests simulés sans réseau réel : changements des résultats du jour/futur sans effet
sur ses probabilités ou sa composition, parité modèle/sélecteur, scores calculés à
la main, bootstrap par journée, données invalides, budget de trente appels, délais,
cache idempotent, corruption, refus/pagination, absence de clé, secret factice
expurgé et refus de sorties dans le dépôt (y compris liens symboliques).
Les tests comptent les appels effectifs du fetch simulé : trente au total malgré
changement de sortie, suppression du journal, relance et deux processus simultanés.
Trente refus HTTP 503 épuisent également l'enveloppe ; les tentatives interrompues
restent comptées. Onze permutations d'entrée reproduisent le même rapport.

`npm ci` et `npm run check` sur copie propre sans `.workmux/PROMPT-*.md` ; ne pas
modifier ces prompts. PR vers `dev`, CI verte, rapport hors dépôt. La durée et la
mémoire locales sont mesurées par le runner, et la mesure est reprise dans la PR.
Ce n'est pas une optimisation avec promesse d'amélioration prédictive.

**Aucune migration de base** : outil hors ligne additif, sans R2, SQL ou connexion
de production. L'ancienne version reste compatible. Pas de table/colonne supprimée,
verrou SQL, index nouveau ou `EXPLAIN` applicable. Plan de retour : retirer les
scripts, la fixture synthétique et l'ADR, conserver les jeux et rapports extérieurs
pour audit ; ne pas effacer le registre global de budget pour refaire des appels.
Si ce correctif est retiré, suspendre la collecte ; ne pas réactiver l'ancien
collecteur dépourvu du registre global. L'application et le runner hors ligne
restent compatibles avec les jeux existants. Aucune
donnée de production n'a besoin d'être restaurée. Une migration montante ou
descendante n'est donc pas requise.
