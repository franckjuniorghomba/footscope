# Relais API-Football à IP fixe

Le relais facultatif utilise l’IP de sortie d’un VPS dédié. Le Worker conserve son cache, ses pauses et ses limites. Cela peut résoudre un refus lié à une IP partagée, sans garantir l’accès fournisseur ni valider le modèle statistique.

## Installation rapide : une commande depuis le PC

Sur **WSL Ubuntu du PC**, dans la copie locale du dépôt au commit approuvé de la PR #2 :

```bash
bash scripts/relay-install.sh <ip-du-droplet>
```

Remplacer `<ip-du-droplet>` par l’IPv4 publique réelle. Exemple de domaine dérivé : `203.0.113.42` → `203-0-113-42.sslip.io`. Aucun bloc à coller sur le VPS, aucune saisie ou copie du jeton pendant l’installation.

Prérequis : Droplet **Ubuntu 24.04** dédié, accès SSH root par clé/agent et empreinte vérifiée dans `known_hosts` sur le PC ; Git, OpenSSL, OpenSSH, curl et util-linux (flock) sur WSL. Un mot de passe seul ne convient pas : le contrôle `ssh -o BatchMode=yes root@IP true` échoue avec un diagnostic avant toute génération. Le script exige une empreinte connue ; vérifier celle du Droplet par un canal de confiance avant la première connexion SSH. La confirmation `oui` autorise l’installation sur ce Droplet ; aucun agent ne lance ce déploiement.

Configurer auparavant le pare-feu DigitalOcean : SSH depuis les adresses d’administration, TCP 80/443 et éventuellement UDP 443 ; jamais 8787. Autoriser les sorties DNS et HTTPS. Les ports Docker publiés nécessitent ce filtrage fournisseur, pas seulement UFW. [sslip.io](https://sslip.io/) résout le nom vers l’IP sans créer de zone DNS ; son DNS public et ACME doivent être disponibles. Aucun certificat ignoré.

Le script :

1. Valide l’IPv4, demande confirmation et vérifie SSH sans interaction.
2. Génère le jeton sur le PC, sans affichage, dans `~/.config/footscope/relay-token` (0600, dossier 0700, hors dépôt). Réutilise ce fichier sur toute reprise ; ne jamais le supprimer pour contourner une erreur.
3. Envoie une archive `git archive HEAD` contenant **uniquement** `deploy/relay/` et `scripts/relay.mjs`, par SCP. Les modifications non committées ne sont pas installées. Aucun Git ni accès GitHub sur le VPS.
4. Envoie le script distant sur stdin SSH ; sa fonction finale lit le jeton sur cette même entrée, sans argument de commande ni historique. Crée le `.env` en 0600 et s’arrête si un fichier existant diffère du domaine/jeton PC, sans l’écraser. Installe Docker via le [dépôt officiel Ubuntu en deb822](https://docs.docker.com/engine/install/ubuntu/) si Docker/Compose ne fonctionnent pas déjà ; aucun upgrade implicite d’une installation opérationnelle. Les paquets Docker suivent le dépôt stable lors de la première installation ; les images applicatives sont figées. Un conflit de paquets doit être corrigé par l’exploitant, sans désinstallation automatique.
5. Extrait dans `~/footscope`, génère le `.dockerignore` racine excluant les `.env`, `.git` et les artefacts locaux, puis lance `docker compose up --build -d --wait --wait-timeout 120`. Les fichiers versionnés sont remplacés ; jeton et volumes sont conservés. Des verrous PC/VPS empêchent deux installations simultanées.
6. Attend `/health` HTTPS : 30 essais maximum, timeout de 5 s, pause de 5 s (moins de 5 minutes après Compose). Exige exactement `{"ready":true}`, puis vérifie encore HTTPS depuis le PC (timeout 10 s). Aucun appel fournisseur.
7. Affiche seulement `API_FOOTBALL_BASE_URL=https://<domaine>/` et le nom `API_RELAY_TOKEN`. **À la toute fin**, `clip.exe < fichier` copie le jeton dans Windows sans l’afficher. Si `clip.exe` manque, activer l’interopérabilité Windows de WSL et relancer la même commande ; le jeton sera réutilisé. Aucun repli par affichage du secret.

Après succès, dans Codex connecté au **compte propriétaire du site existant** identifié par `.openai/hosting.json`, demander la saisie sécurisée du secret serveur `API_RELAY_TOKEN`. Coller le jeton **une seule fois dans ce champ secret**, jamais dans un message de conversation, commentaire ou commande. Poser `API_FOOTBALL_BASE_URL` avec le `/` final, conserver `API_FOOTBALL_KEY`, puis faire appliquer la configuration par le responsable via le workflow Sites. Si le canal de saisie sécurisé n’est pas disponible, conserver le mode direct. Vider le presse-papiers après saisie ; désactiver au préalable son historique/synchronisation et l’enregistrement du terminal. Conserver le fichier privé pour les reprises ; ne pas le joindre aux livrables ou aux sauvegardes partagées.

Toute erreur arrête l’installation avant la copie du jeton et l’activation Sites. Corriger puis relancer la même commande. Une panne DNS/TLS ou un refus fournisseur doit être signalé comme tel, jamais comme une absence de sélection. Ne jamais utiliser `set -x`, `curl -v`, `cat .env` ou `docker compose config` dans une sortie partagée.

## Sécurité et validation

Les deux processus sont non-root ; le relais n’a aucun port publié. Les journaux d’accès **et runtime/erreur** de Caddy filtrent `request>headers>X-Relay-Token` et `request>headers>X-Apisports-Key` avant écriture. Les champs non sensibles restent disponibles, avec rotation Docker (3 fichiers de 10 Mo par service). Ne pas ajouter de logger non filtré. [Filtres](https://caddyserver.com/docs/caddyfile/directives/log), [logger runtime](https://caddyserver.com/docs/caddyfile/options#log).

HSTS est explicite (`max-age=31536000`), erreurs HTTPS comprises, sans `includeSubDomains` ni `preload`. Le Worker utilise toujours HTTPS avec un certificat valide. L’exploitant du VPS peut accéder à la clé en transit : réserver le relais à une machine maîtrisée. Le relais refuse les routes/méthodes non autorisées et les redirections, ne transmet pas son jeton au fournisseur et conserve 429 et `Retry-After`.

`npm ci` et `npm run check` utilisent uniquement des données fictives. `tests/relay-install.mjs` simule SSH, SCP, Docker, curl et le presse-papiers dans le PATH, avec archive/extraction et exécution Bash réelles. Il vérifie reprise, permissions, arrêts et absence du jeton fictif dans les sorties, arguments/environnements des commandes et fichiers du dépôt. `bash scripts/check-relay-containers.sh` en CI construit les images figées et vérifie utilisateurs, Compose et HTTPS sur loopback. Aucun déploiement.

Pour tester les journaux avec Caddy 2.10.2 local : définir `CADDY_BIN` vers le binaire et lancer `node scripts/test-relay-security.mjs`. PKI éphémère et fournisseur simulé ; zéro fuite exigée et HSTS sur 200/401/404/502. Avec l’ancien Caddyfile en argument, le test échoue sur la fuite.

## Mises à jour et retour arrière

Node 24.21.0 / Alpine 3.23 et Caddy 2.10.2 / Alpine sont figés par version et digest multiarchitecture. Aucun compilateur dans les images finales. La capacité de fichier de Caddy est retirée pour `cap_drop: ALL` ; son sysctl autorise les ports bas sans capacité supplémentaire.

Pour modifier les images : lire les notes officielles, vérifier les digests avec `docker buildx imagetools inspect`, modifier les Dockerfiles dans une PR, aligner les tests/CI et faire approuver le SHA après CI verte. Conserver le SHA précédent sécurisé. Sur le PC, récupérer et sélectionner le nouveau commit approuvé puis relancer la commande d’installation ; aucune rotation du jeton.

Retour arrière, déclenché par le responsable : retirer `API_FOOTBALL_BASE_URL` et `API_RELAY_TOKEN` des secrets Sites, appliquer le mode direct **avant** l’arrêt du relais. Cela peut réintroduire le refus de l’IP partagée. Depuis le PC :

```bash
ssh root@<ip-du-droplet> 'cd ~/footscope/deploy/relay && docker compose stop'
```

Les volumes et `.env` sont conservés. Pour revenir à une version précédente **déjà sécurisée**, sélectionner son SHA dans une copie PC. Si ce commit précède le script, restaurer seulement le script approuvé avec `git restore --source=<SHA-du-script-approuvé> -- scripts/relay-install.sh` (sans créer de commit), puis relancer `bash scripts/relay-install.sh <ip-du-droplet>` : l’archive utilise HEAD. Ne pas restaurer le Caddyfile vulnérable, supprimer les volumes ou desserrer les filtres.

## Annexe : procédure manuelle pour l’exploitant

Cette voie est réservée au diagnostic d’un exploitant ; l’installation rapide ci-dessus reste le parcours du responsable. Aucun transfert de secret par copier-coller entre terminaux.

1. Vérifier SSH, DNS, pare-feu et Ubuntu 24.04. Installer Docker Engine et Compose en suivant la méthode officielle deb822 liée ci-dessus (clé `/etc/apt/keyrings/docker.asc`, source `/etc/apt/sources.list.d/docker.sources`, `DPkg::Lock::Timeout=300`). Ne pas remplacer une installation fonctionnelle.
2. Sur le PC au SHA approuvé, produire `git archive --format=tar HEAD deploy/relay scripts/relay.mjs` dans un fichier temporaire privé et le transférer par SCP. Sur le VPS, extraire dans `~/footscope`. Générer le `.dockerignore` racine avec les exclusions du script avant tout build (`.env`, `.git` et artefacts locaux). Le contexte Node `../..` trouve alors `scripts/relay.mjs` ; le contexte Caddy possède déjà son `.dockerignore`.
3. Pour le `.env`, employer le transfert sur stdin de `scripts/relay-install.sh` : le jeton vient uniquement du fichier privé PC ; validation stricte avant écriture atomique 0600 ; fichier existant identique conservé, différent refusé. Ne pas saisir un jeton dans un shell SSH interactif ni sourcer un `.env` non contrôlé.
4. Dans `~/footscope/deploy/relay`, lancer `docker compose up --build -d --wait --wait-timeout 120`. Attendre HTTPS sain avec la boucle bornée du script, puis vérifier depuis le PC. Les volumes conservent les certificats publics renouvelés par Caddy.
5. Configurer Sites seulement après santé vérifiée, via son champ secret. La copie Windows intervient exclusivement à la fin du script PC. Pour toute reprise, utiliser le même fichier privé.

Un essai `/status` appelle réellement API-Football et requiert une autorisation distincte du responsable avec un budget d’une requête. Préparer un script dédié lisant la clé sans affichage et transmettant les en-têtes à curl via stdin (`--header @-`), sans reprise automatique. Aucun agent ni aucune CI ne l’exécute ; ne pas publier les données du compte. `/health` suffit à l’installation et ne consomme aucun quota fournisseur.
