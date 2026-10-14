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

## Validation et retour arrière

```sh
npm ci
node tests/backtest.mjs
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
