# Relais API-Football à IP fixe

Le relais facultatif utilise l’IP de sortie d’un VPS dédié. Le Worker conserve son cache, ses pauses et ses limites. Cela peut résoudre un refus lié à une IP partagée, sans garantir l’accès fournisseur ni valider le modèle statistique. Ce dépôt ne provisionne et ne déploie rien : les étapes suivantes sont exécutées par le responsable humain.

## Préparer un VPS Ubuntu neuf

1. Utiliser Ubuntu 24.04 LTS avec une IP publique fixe et un accès SSH maîtrisé. Dans le pare-feu du fournisseur, autoriser SSH seulement depuis les adresses d’administration, TCP 80/443 et éventuellement UDP 443 ; ne jamais ouvrir 8787. Autoriser les sorties DNS et HTTPS. Les ports Docker publiés nécessitent aussi le filtrage du fournisseur, pas seulement UFW.
2. Créer un enregistrement DNS A `relay.example.com` vers l’IPv4 du VPS, en mode DNS seul (sans proxy Cloudflare). Ne créer un AAAA que si IPv6 fonctionne réellement. Vérifier depuis sa machine avec `getent ahosts relay.example.com`. Pour ce pilote, choisir un domaine avec certificat public : une IP seule ne suffit pas à cette configuration et ne justifie pas un certificat ignoré par `curl -k` ou par le Worker.
3. Installer Docker Engine et Compose depuis le [dépôt officiel Docker](https://docs.docker.com/engine/install/ubuntu/). Exécuter dans Bash, sans traçage `set -x` :

```bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF_DOCKER
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF_DOCKER
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

4. Récupérer le dépôt avec son accès GitHub existant (aucun jeton dans l’URL). Après revue de la PR #2, utiliser le SHA approuvé, pas une branche mobile. Ces commandes se relancent sans écraser `.env` :

```bash
set -euo pipefail
if [ ! -d footscope/.git ]; then
  git clone https://github.com/franckjuniorghomba/footscope.git footscope
fi
cd footscope
git fetch origin
read -rp 'SHA approuvé à installer : ' RELAY_COMMIT
git checkout --detach "$RELAY_COMMIT"
cd deploy/relay
umask 077
if [ ! -e .env ]; then
  read -rp 'Nom DNS du relais : ' RELAY_DOMAIN
  RELAY_TOKEN=$(openssl rand -hex 32)
  printf 'RELAY_DOMAIN=%s\nRELAY_TOKEN=%s\n' "$RELAY_DOMAIN" "$RELAY_TOKEN" > .env
  unset RELAY_TOKEN
fi
chmod 600 .env
```

`openssl rand -hex 32` génère 64 caractères aléatoires, au-delà du minimum de 32. Le fichier local `.env` est ignoré par Git. Le jeton n’est ni une clé fournisseur ni une valeur à copier dans un journal. Sur une reprise, conserver le fichier existant ; changer un jeton exige sa rotation coordonnée dans Sites.

## Démarrer et vérifier

Depuis `footscope/deploy/relay` :

```bash
set -euo pipefail
sudo docker compose build --pull
sudo docker compose up -d --wait --wait-timeout 120
sudo docker compose ps
set -a
source .env
set +a
curl --fail --silent --show-error "https://$RELAY_DOMAIN/health"
```

Caddy obtient et renouvelle le certificat public grâce au DNS et aux ports 80/443. Les volumes conservent les certificats. Les deux processus sont non-root ; le relais n’a aucun port publié. `/health` indique uniquement que le processus est prêt et ne consomme aucun quota fournisseur. Un échec DNS/TLS, 401, 429 ou 502 doit être signalé comme tel, jamais présenté comme une absence de sélection.

Les journaux d’accès **et runtime/erreur** de Caddy filtrent `request>headers>X-Relay-Token` et `request>headers>X-Apisports-Key` avant leur écriture. Désactiver les seuls journaux d’accès ne protège pas les erreurs. Les champs non sensibles restent disponibles, avec rotation Docker (3 fichiers de 10 Mo par service). Ne pas activer de logger supplémentaire non filtré, ni de traçage. [Référence des filtres](https://caddyserver.com/docs/caddyfile/directives/log), [logger runtime global](https://caddyserver.com/docs/caddyfile/options#log).

HSTS est explicite (`max-age=31536000`), erreurs HTTPS comprises. Ni `includeSubDomains` ni `preload` ne sont imposés au domaine parent. HSTS ne garantit pas la protection du client serveur Node : le Worker doit toujours utiliser HTTPS avec un certificat valide.

### Essai humain facultatif vers /status

Cette commande appelle réellement API-Football **une fois**, sans reprise automatique. L’exécuter seulement après autorisation du responsable et accord sur ce budget. Aucun agent ni aucune CI ne l’exécute. Elle lit la clé sans l’afficher et passe les en-têtes par l’entrée standard de curl, sans valeurs secrètes dans les arguments du processus :

```bash
set -euo pipefail
set +x
set -a
source .env
set +a
read -rsp 'Clé API-Football (non affichée) : ' API_FOOTBALL_KEY
printf '\n'
{
  printf 'x-relay-token: %s\n' "$RELAY_TOKEN"
  printf 'x-apisports-key: %s\n' "$API_FOOTBALL_KEY"
} | curl --fail-with-body --silent --show-error --max-time 25 \
  --header @- "https://$RELAY_DOMAIN/status"
unset API_FOOTBALL_KEY RELAY_TOKEN
```

Vérifier les données, les erreurs applicatives et les quotas de la réponse ; un HTTP 200 seul ne prouve pas l’accès. Ne pas publier le contenu du compte ou les clés. Ne pas utiliser `curl -v`, `set -x` ou `docker compose config` dans une sortie partagée : ils peuvent exposer les secrets.

## Configurer Sites après les vérifications humaines

Dans les secrets serveur du site FootScope existant dans Sites, poser exactement :

- `API_FOOTBALL_BASE_URL` : `https://relay.example.com/` (adapter au DNS vérifié).
- `API_RELAY_TOKEN` : la valeur `RELAY_TOKEN` du `.env` local, au moins 32 caractères. La transférer via un canal privé au responsable, jamais via Git, un commentaire ou le navigateur de l’application.

Conserver `API_FOOTBALL_KEY` dans les secrets serveur Sites. L’humain applique ensuite la configuration selon le workflow de publication Sites. L’exploitant du VPS peut accéder à la clé en transit : réserver ce relais à une machine maîtrisée. Le relais refuse les routes/méthodes non autorisées et les redirections ; il ne transmet pas son jeton au fournisseur et conserve 429 et `Retry-After`.

## Validation locale et CI

`npm ci` et `npm run check` restent sans secrets. Pour tester Caddy 2.10.2 installé localement :

```bash
CADDY_BIN=/chemin/vers/caddy node scripts/test-relay-security.mjs
```

Le test démarre HTTPS sur loopback avec une PKI éphémère et un fournisseur simulé, puis arrête le relais. Il recherche les valeurs fictives dans stdout/stderr et exige des journaux d’accès/erreur ainsi que HSTS sur 200/401/404/502. Avec l’ancien Caddyfile passé en argument, il échoue sur la fuite. Aucune requête fournisseur ni ACME publique.

La CI exécute aussi `bash scripts/check-relay-containers.sh` : construction des images figées, vérification des utilisateurs non-root et démarrage Compose sur localhost uniquement. Elle ne déploie rien.

## Images, mises à jour et retour arrière

Les bases Node 24.21.0 / Alpine 3.23 et Caddy 2.10.2 / Alpine sont figées par version **et digest multiarchitecture** dans les deux Dockerfiles. Le Caddy final ajoute seulement la propriété des répertoires, sans compilateur ; Node copie uniquement le script du relais et fonctionne sous `node`. Le sysctl du conteneur Caddy autorise ses ports bas sans capacité supplémentaire.

Pour une mise à jour : lire les notes de sécurité officielles Node/Caddy/Alpine, choisir les versions, vérifier les digests du registre officiel (`docker buildx imagetools inspect node:VERSION` et `caddy:VERSION`), modifier les deux Dockerfiles dans une PR. Si Caddy change, adapter la version exigée par le test ; si Node change, aligner la CI. Exécuter les tests locaux et la CI, puis faire approuver le SHA. Les tags majeurs mobiles ne sont pas admis. Le responsable conserve le SHA précédent et ses images avant `build --pull`, puis lance lui-même la mise à jour avec `docker compose up -d --wait`.

Retour au mode direct : l’humain retire `API_FOOTBALL_BASE_URL` et `API_RELAY_TOKEN` des secrets Sites et applique sa configuration. Cela peut réintroduire le refus de l’IP partagée. Ensuite, sur le VPS :

```bash
sudo docker compose stop
```

Les volumes et `.env` sont conservés. Pour reprendre, `sudo docker compose up -d --wait`. Pour revenir à une version précédente **déjà sécurisée**, vérifier le SHA enregistré avec `git checkout --detach SHA_PRECEDENT`, puis reconstruire et redémarrer comme ci-dessus. Ne pas revenir à l’ancien Caddyfile vulnérable ; en cas d’incident sur cette première version sécurisée, arrêter le relais et revenir au mode direct. Ne pas supprimer les volumes de certificats et ne pas desserrer les limites ou filtres de FootScope.

Les reprises du programme et des fiches restent limitées à deux essais automatiques ; un changement de date, filtre, fiche ou onglet annule la reprise, une action manuelle commence une nouvelle série.
