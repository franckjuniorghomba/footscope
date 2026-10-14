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
node scripts/backtest/collect.mjs --out "$JARVIS_LIVRABLES/api-football"
node scripts/backtest/run.mjs \
  --input "$JARVIS_LIVRABLES/api-football/dataset.json" \
  --out "$JARVIS_LIVRABLES/historical"
```

Sans clé, le collecteur échoue explicitement avant tout appel. Un abonnement dont
la couverture n'inclut pas ces saisons peut également refuser la collecte. Il faut
alors signaler ce refus, sans annoncer de résultat prédictif ni acheter de données.

Un appel `fixtures?league=…&season=…` par couple, **trente tentatives maximum**,
espacées de 6,5 secondes. Aucun autre endpoint, aucun appel par match, aucune
pagination supplémentaire et aucun retry automatique. Le journal `collection.json`
réserve la tentative avant le réseau ; un timeout, un refus ou une interruption
consomment donc leur tentative. Les erreurs et corps de réponse ne sont pas
recopiés dans les journaux. Les données conservées se limitent aux identifiants,
équipes, date, ligue, statut et score publics des rencontres.

Conserver **le même dossier et le même journal** pendant toute cette collecte
unique. Ne pas repartir dans un dossier neuf pour contourner le budget. La relance
réutilise les fichiers terminés après vérification SHA-256, même sans clé. Une
réponse en erreur ou paginée, une somme différente ou un couple déjà tenté sans
cache arrête la collecte pour examen manuel ; ne pas effacer son entrée pour
réessayer. Après un arrêt brutal, vérifier que le processus est terminé avant de
retirer manuellement `collect.lock`. Ne pas lancer simultanément une autre collecte
payante avec la même clé ; la coordination des appels du Worker demeure inchangée.

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
jeux et rapports hors dépôt pour audit. Aucune table, colonne ou donnée de production
n'est touchée. Voir `docs/adr/0001-backtest.md` pour les limites scientifiques et
les futures décisions de sources.
