# Relais API-Football à IP fixe

Le relais est facultatif. Il sert à identifier la collecte par l’IP de sortie d’un serveur dédié et conserve les limites, le cache et les pauses du Worker. Il ne garantit pas la disparition des limitations ni une meilleure qualité prédictive. Aucun serveur n’est provisionné ou déployé par ce code.

## Installation

Utiliser un serveur autorisé avec Node.js 24 et une IP de sortie fixe. Copier `scripts/relay.mjs`, puis définir `RELAY_TOKEN` dans le gestionnaire de secrets du serveur : une valeur aléatoire d’au moins 32 caractères. Définir éventuellement `PORT` (8787 par défaut), puis lancer :

```sh
node scripts/relay.mjs
```

Le processus écoute seulement sur `127.0.0.1`. Placer un reverse proxy HTTPS sur ce même serveur, avec certificat valide, vers ce port. Ne pas exposer le port HTTP directement. Le reverse proxy ne doit pas journaliser les en-têtes `x-relay-token` et `x-apisports-key`.

Dans les secrets de l’hébergement FootScope, définir :

- `API_FOOTBALL_BASE_URL` : URL HTTPS du relais, par exemple `https://relay.example/`.
- `API_RELAY_TOKEN` : même secret que `RELAY_TOKEN`.
- `API_FOOTBALL_KEY` : clé conservée dans le Worker, transmise au relais puis au fournisseur.

L’exploitant du relais peut accéder à la clé pendant son transit : utiliser seulement une machine maîtrisée. Ne jamais placer ces valeurs dans le dépôt ou le navigateur. Le relais n’envoie pas son jeton au fournisseur, refuse les autres routes et méthodes, et ne suit aucune redirection. Il conserve les réponses 429 et `Retry-After`.

## Vérification et retour au mode direct

Les tests du dépôt démarrent un relais local avec un fournisseur simulé : aucune requête payante. Pour un essai réel, convenir d’un budget de requêtes et vérifier le certificat, l’IP de sortie et les pauses du fournisseur.

Pour revenir au fournisseur direct, retirer `API_FOOTBALL_BASE_URL` et `API_RELAY_TOKEN`. Ne pas désactiver les filtres ou les limites pour obtenir un coupon.

Les reprises du programme et des fiches sont limitées à deux essais automatiques. Un changement de date, de filtre, de fiche ou d’onglet de l’application annule la reprise en attente. Une action manuelle commence une nouvelle série d’essais.
