# Instructions pour les agents de FootScope

## Travail attendu

Lire README.md et docs/ARCHITECTURE.md. Prendre une seule tâche délimitée, avec un critère d’acceptation mesurable. Travailler sur une branche et proposer une pull request expliquant le problème, la correction et sa validation.

Les agents autonomes ou planifiés n’effectuent ni fusion ni déploiement. Une intervention interactive explicitement autorisée peut suivre le workflow normal de publication du projet.

## Invariants

- Aucun secret dans les commits, journaux, prompts ou ressources du navigateur.
- Analyse de tous les matchs du périmètre ; ne pas réintroduire une limite aux premiers matchs.
- Un événement par match, quatre maximum, un seul bookmaker pour un combiné.
- Aucune admission fondée seulement sur une cote basse ou sur l’avis du LLM.
- Le LLM explique les décisions ; il ne calcule pas librement les probabilités et ne contourne pas les filtres.
- `modelValidated` et `realMoneyEligible` restent faux jusqu’à une validation indépendante documentée et une décision explicite du responsable.
- Ne pas desserrer les seuils pour forcer un coupon. Ne pas inventer les données absentes.
- Respecter les délais du fournisseur et les limites de requêtes ; conserver le cache et la coordination entre serveurs.
- Préserver GMT−5 fixe et les règles de règlement des marchés pris en charge.

## Modules et collaboration

Limiter les fichiers modifiés au périmètre de la tâche. Pour des travaux simultanés, utiliser des branches distinctes et éviter deux agents qui modifient les mêmes modules. Une modification d’interface entre modules doit être documentée et coordonnée avant intégration.

## Validation

```sh
npm ci
npm run check
```

Les tests ordinaires utilisent des fixtures simulées et ne nécessitent aucun secret. Les vérifications réelles de services payants doivent être explicitement autorisées, bornées et expurgées de toute valeur secrète.

Pour une optimisation, donner une mesure avant/après : requêtes évitées, durée, mémoire ou CPU sur le même scénario. Pour un modèle, utiliser une séparation temporelle et des résultats hors échantillon ; un test de fonction n’est pas une validation prédictive.

## Livraison

Présenter une PR courte, sa mesure d’amélioration, les tests exécutés et les limites restantes. Signaler les problèmes d’infrastructure impossibles à corriger dans le code. Ne pas masquer un échec externe derrière « aucune sélection intéressante ».
