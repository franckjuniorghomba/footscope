# Relais API-Football à IP fixe

> [!IMPORTANT]
> **Installation rapide — Droplet DigitalOcean Ubuntu 24.04 neuf**
> Suivre les étapes numérotées ci-dessous dans l’ordre. Chaque bloc Bash se copie tel quel ; les valeurs non secrètes sont demandées au clavier. Les blocs VPS tournent dans un sous-shell : une erreur arrête le bloc et laisse la session SSH ouverte. Corriger l’erreur avant de relancer la même étape. Transférer une archive minimale depuis le PC : aucun clonage ni identifiant GitHub sur le VPS. Exemple : `203.0.113.42` → `203-0-113-42.sslip.io`. **Si l’invite `$` réapparaît avant la question du jeton, ne rien coller.** Aucun agent ne déploie cette procédure.

Le relais facultatif utilise l’IP de sortie d’un VPS dédié. Le Worker conserve son cache, ses pauses et ses limites. Cela peut résoudre un refus lié à une IP partagée, sans garantir l’accès fournisseur ni valider le modèle statistique.

## Installation rapide

Prérequis : PC du responsable avec Bash et OpenSSL (macOS, Linux ou WSL), presse-papiers local (`pbcopy`, `wl-copy`, `xclip` ou `clip.exe`), copie locale du dépôt privé sur le PC et accès GitHub sur ce PC sans jeton dans l’URL, et Codex connecté au compte propriétaire du site FootScope dans Sites. Désactiver l’enregistrement du terminal et l’historique/synchronisation du presse-papiers avant toute manipulation de secret. Ne jamais utiliser `set -x`, `curl -v`, `cat .env` ou `docker compose config`.

1. **PC : vérifier le domaine puis ouvrir SSH.** Dans le pare-feu DigitalOcean, autoriser SSH seulement depuis les adresses d’administration, TCP 80/443 et éventuellement UDP 443 ; ne jamais ouvrir 8787. Autoriser les sorties DNS et HTTPS. Les ports Docker publiés nécessitent ce filtrage du fournisseur, pas seulement UFW. Pour ce pilote, utiliser `<ip-avec-tirets>.sslip.io` : par exemple, l’IP illustrative `203.0.113.42` donne `203-0-113-42.sslip.io` (remplacer par l’IP réelle du Droplet). Ce nom résout directement vers l’IP, sans créer de zone DNS. Un domaine propre en DNS seul est aussi possible ; aucun AAAA sans IPv6 fonctionnel. Le certificat public reste obligatoire.

   ```bash
   (
     set +x
     set -euo pipefail
     trap 'printf "Étape interrompue : commande, saisie ou fichier en échec ; corriger avant de continuer. Ne coller aucun secret dans le shell.\n" >&2' ERR
     read -rp 'IPv4 publique du Droplet : ' RELAY_IP </dev/tty
     RELAY_DOMAIN="${RELAY_IP//./-}.sslip.io"
     printf 'Domaine à saisir sur le VPS et dans Sites : %s\n' "$RELAY_DOMAIN"
     [[ "$RELAY_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { printf 'IPv4 invalide.\n' >&2; exit 1; }
     IFS=. read -r -a RELAY_OCTETS <<< "$RELAY_IP"
     for RELAY_OCTET in "${RELAY_OCTETS[@]}"; do
       (( 10#$RELAY_OCTET <= 255 )) || { printf 'IPv4 invalide.\n' >&2; exit 1; }
     done
     if command -v getent >/dev/null; then getent hosts "$RELAY_DOMAIN";
     else nslookup "$RELAY_DOMAIN"; fi
     read -rp 'Utilisateur SSH (root sur un Droplet neuf) : ' RELAY_SSH_USER </dev/tty
     [[ "$RELAY_SSH_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { printf 'Utilisateur SSH invalide.\n' >&2; exit 1; }
     ssh "$RELAY_SSH_USER@$RELAY_IP"
   )
   ```

   Vérifier que la réponse DNS contient l’IP du Droplet. Garder le terminal SSH ouvert et ouvrir **un deuxième terminal local sur le PC** pour l’étape 2. Le domaine et l’IP ne sont pas des secrets. [Fonctionnement sslip.io](https://sslip.io/).

2. **PC, terminal local : générer le jeton sans l’afficher et le copier.** Le fichier privé `~/.footscope-relay-token` permet de recopier **le même** jeton en relançant ce bloc ; ne pas le régénérer entre Sites et le VPS. Le jeton est créé uniquement sur le PC. Aucun secret ne passe dans les arguments d’un processus ni dans l’historique du shell.

   ```bash
   (
     set +x
     set -euo pipefail
     trap 'printf "Étape interrompue : commande, saisie ou fichier en échec ; corriger avant de continuer. Ne coller aucun secret dans le shell.\n" >&2' ERR
     umask 077
     if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v clip.exe >/dev/null; then
       RELAY_CLIPBOARD=(clip.exe)
     elif command -v pbcopy >/dev/null; then
       RELAY_CLIPBOARD=(pbcopy)
     elif command -v wl-copy >/dev/null; then
       RELAY_CLIPBOARD=(wl-copy)
     elif command -v xclip >/dev/null; then
       RELAY_CLIPBOARD=(xclip -selection clipboard)
     elif command -v clip.exe >/dev/null; then
       RELAY_CLIPBOARD=(clip.exe)
     else
       printf 'Installer un outil de presse-papiers local avant de continuer.\n' >&2
       exit 1
     fi
     if [ ! -e "$HOME/.footscope-relay-token" ]; then
       RELAY_TOKEN=$(openssl rand -hex 32)
       printf '%s' "$RELAY_TOKEN" > "$HOME/.footscope-relay-token"
       unset RELAY_TOKEN
     fi
     [ -f "$HOME/.footscope-relay-token" ] && [ ! -L "$HOME/.footscope-relay-token" ] || { printf 'Fichier du jeton absent, non régulier ou lien symbolique.\n' >&2; exit 1; }
     chmod 600 "$HOME/.footscope-relay-token"
     RELAY_TOKEN=$(< "$HOME/.footscope-relay-token")
     [[ "$RELAY_TOKEN" =~ ^[0-9a-f]{64}$ ]] || {
       printf 'Fichier du jeton invalide ; ne pas activer le relais.\n' >&2
       exit 1
     }
     printf '%s' "$RELAY_TOKEN" | "${RELAY_CLIPBOARD[@]}"
     unset RELAY_TOKEN
     printf 'Jeton copié sans affichage ; utiliser uniquement les saisies secrètes.\n'
   )
   ```

   Dans Codex connecté au **compte du site existant**, demander : « Préparer les secrets serveur du site FootScope identifié par `.openai/hosting.json` : `API_RELAY_TOKEN` comme secret. Ne pas encore ajouter `API_FOOTBALL_BASE_URL` ; attendre l’étape 6. Ouvrir la saisie sécurisée Sites pour le jeton. Ne pas publier avant ma vérification HTTPS. » Coller le presse-papiers **une fois dans le champ secret de Sites**, jamais dans le message à Codex, un commentaire, une commande ou l’interface FootScope. Conserver `API_FOOTBALL_KEY`. Si la session ne propose pas de saisie sécurisée de secret, conserver le mode direct et faire rétablir ce canal ; ne pas improviser un transfert par conversation. L’activation attend l’étape 6.

3. **VPS, terminal SSH : installer Docker Engine et Compose.** Bloc adapté au [dépôt officiel Docker pour Ubuntu](https://docs.docker.com/engine/install/ubuntu/). Il se relance sans ajouter de doublon au dépôt apt.

   ```bash
   (
     set +x
     set -euo pipefail
     trap 'printf "Étape interrompue : commande, saisie ou fichier en échec ; corriger avant de continuer. Ne coller aucun secret dans le shell.\n" >&2' ERR
     sudo apt-get -o DPkg::Lock::Timeout=300 update
     sudo apt-get -o DPkg::Lock::Timeout=300 install -y ca-certificates curl openssl
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
     sudo apt-get -o DPkg::Lock::Timeout=300 update
     sudo apt-get -o DPkg::Lock::Timeout=300 install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
     sudo systemctl enable --now docker
     sudo docker version
     sudo docker compose version
   )
   ```

4. **PC : envoyer uniquement les fichiers du relais, puis VPS : extraire.** Dans le terminal local, se placer à la racine de la copie du dépôt privé. Le SHA complet est celui approuvé sur la PR #2 ; `git archive` ignore les fichiers locaux et les secrets. Aucun accès GitHub, clone, clé de déploiement ou jeton GitHub sur le Droplet. La connexion SSH est celle de l’étape 1 ; vérifier son empreinte avant le transfert.

   ```bash
   (
     set +x
     set -euo pipefail
     trap 'printf "Transfert interrompu : vérifier saisie, SHA local et SSH ; ne pas continuer.\n" >&2' ERR
     git rev-parse --show-toplevel >/dev/null
     read -rp 'SHA complet approuvé à installer : ' RELAY_COMMIT </dev/tty
     [[ "$RELAY_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { printf 'SHA invalide : 40 caractères hexadécimaux minuscules requis.\n' >&2; exit 1; }
     git cat-file -e "$RELAY_COMMIT^{commit}" || { printf 'Commit absent du PC : récupérer la branche approuvée sur le PC.\n' >&2; exit 1; }
     read -rp 'Destination SSH (ex. root@203.0.113.42) : ' RELAY_DEST </dev/tty
     [[ "$RELAY_DEST" =~ ^[a-z_][a-z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { printf 'Destination SSH invalide.\n' >&2; exit 1; }
     RELAY_PACKAGE=$(mktemp)
     trap 'rm -f "$RELAY_PACKAGE"' EXIT
     git archive --format=tar "$RELAY_COMMIT" deploy/relay scripts/relay.mjs .dockerignore > "$RELAY_PACKAGE"
     scp "$RELAY_PACKAGE" "$RELAY_DEST:footscope-relay.tar"
     printf 'Archive transférée depuis le SHA %s ; poursuivre sur le VPS.\n' "$RELAY_COMMIT"
   )
   ```

   Dans le terminal SSH du VPS, copier ce bloc. Relançable : les fichiers versionnés sont remplacés, `.env` et les volumes sont conservés. L’archive provient exclusivement du PC de confiance.

   ```bash
   (
     set +x
     set -euo pipefail
     trap 'printf "Extraction interrompue : archive ou fichier requis absent ; ne pas continuer.\n" >&2' ERR
     [ -s "$HOME/footscope-relay.tar" ] || { printf 'Archive manquante ou vide : refaire le transfert PC.\n' >&2; exit 1; }
     mkdir -p "$HOME/footscope"
     tar -xf "$HOME/footscope-relay.tar" -C "$HOME/footscope"
     cd "$HOME/footscope"
     for RELAY_FILE in .dockerignore deploy/relay/compose.yml deploy/relay/Caddyfile deploy/relay/Dockerfile deploy/relay/Dockerfile.caddy deploy/relay/.dockerignore scripts/relay.mjs; do
       [ -s "$RELAY_FILE" ] || { printf 'Fichier requis absent ou vide : %s\n' "$RELAY_FILE" >&2; exit 1; }
     done
     printf 'Fichiers du relais prêts ; aucun dépôt Git nécessaire sur VPS.\n'
   )
   ```

   Arborescence attendue sur le VPS (le contexte Docker Node `../..` trouve bien `scripts/relay.mjs`) :

   ```text
   ~/footscope-relay.tar
   ~/footscope/
     .dockerignore          # protège aussi le contexte Node
     deploy/relay/
       .dockerignore
       .env.example         # modèle sans secret
       Caddyfile
       Dockerfile
       Dockerfile.caddy
       compose.yml
       .env                 # créé à l’étape 5 seulement
     scripts/relay.mjs
   ```

5. **VPS : saisir le même jeton dans `.env` sans affichage.** Si nécessaire, relancer le bloc PC de l’étape 2 pour recopier le jeton inchangé. À l’invite masquée, coller le presse-papiers **une fois**, puis Entrée. Le collage est lu par `read -rsp`, pas par l’interpréteur de commandes ; il ne rejoint pas l’historique. Une interruption ne crée pas de `.env` partiel. Sur une reprise, le fichier existant est conservé ; toute rotation ultérieure doit être coordonnée avec Sites.

   ```bash
   (
     set +x
     set -euo pipefail
     trap 'printf "Étape interrompue : commande, saisie ou fichier en échec ; corriger avant de continuer. Ne coller aucun secret dans le shell.\n" >&2' ERR
     cd ~/footscope/deploy/relay
     umask 077
     if [ ! -e .env ]; then
       read -rp 'Nom DNS vérifié (ex. 203-0-113-42.sslip.io) : ' RELAY_DOMAIN </dev/tty
       while :; do
         RELAY_DOMAIN=$(printf '%s' "$RELAY_DOMAIN" | tr '[:upper:]' '[:lower:]')
         RELAY_DOMAIN=${RELAY_DOMAIN#https://}
         RELAY_DOMAIN=${RELAY_DOMAIN%/}
         if [[ ${#RELAY_DOMAIN} -le 253 && "$RELAY_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then break; fi
         printf 'Domaine invalide : nom DNS seul ou https://nom/ ; sans port, chemin, espace ni identifiants. Ne pas coller le jeton ; corriger le domaine.\n' >&2
         read -rp 'Nom DNS à corriger : ' RELAY_DOMAIN </dev/tty
       done
       printf 'Domaine validé : %s ; attendre maintenant l’invite masquée du jeton.\n' "$RELAY_DOMAIN"
       read -rsp 'Coller le jeton du PC (non affiché), puis Entrée : ' RELAY_TOKEN </dev/tty
       printf '\n'
       [[ "$RELAY_TOKEN" =~ ^[0-9a-f]{64}$ ]] || {
         printf 'Jeton invalide ; relancer avec le jeton du PC.\n' >&2
         exit 1
       }
       RELAY_ENV_TMP=$(mktemp .env.XXXXXX)
       trap 'rm -f "$RELAY_ENV_TMP"' EXIT
       printf 'RELAY_DOMAIN=%s\nRELAY_TOKEN=%s\n' "$RELAY_DOMAIN" "$RELAY_TOKEN" > "$RELAY_ENV_TMP"
       mv "$RELAY_ENV_TMP" .env
       unset RELAY_TOKEN
     fi
     [ -f .env ] && [ ! -L .env ] && [ -r .env ] || { printf '.env absent, illisible ou lien symbolique ; ne pas continuer.\n' >&2; exit 1; }
     grep -Eq '^RELAY_DOMAIN=([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' .env &&
       grep -Eq '^RELAY_TOKEN=[0-9a-f]{64}$' .env && [ "$(wc -l < .env)" -eq 2 ] || {
       printf '.env existant invalide ; arrêter et coordonner sa réparation avec Sites, sans afficher son contenu.\n' >&2; exit 1;
     }
     chmod 600 .env
     printf '.env prêt, contenu non affiché.\n'
   )
   ```

   Attendre chaque invite ; ne jamais coller domaine et jeton ensemble. `https://NOM/`, les majuscules et la barre finale sont normalisés. Un domaine invalide redemande le domaine, sans passer à l’invite du jeton. Une saisie interrompue arrête le bloc avec un message : **si l’invite `$` réapparaît avant la question du jeton, ne rien coller**.

   Le fichier est local, privé (0600), ignoré par Git et par les deux contextes Docker. Le jeton de 64 caractères dépasse le minimum de 32. Ne pas extraire le jeton du VPS pour Sites : sa source de reprise est le fichier privé du PC.

6. **VPS : démarrer et attendre HTTPS sain sans appeler le fournisseur.** Compose attend le premier healthcheck du relais (intervalle 30 s), puis Caddy doit encore obtenir le certificat ACME. La boucle attend jusqu’à 30 essais, chacun borné à 5 s, espacés de 5 s (moins de 5 minutes après Compose). Aucun `curl -k`, aucune reprise infinie. La réponse doit être exactement `{"ready":true}`.

   ```bash
   (
     set +x
     set -euo pipefail
     trap 'printf "Étape interrompue : commande, saisie ou fichier en échec ; corriger avant de continuer. Ne coller aucun secret dans le shell.\n" >&2' ERR
     cd ~/footscope/deploy/relay
     sudo docker compose build --pull
     sudo docker compose up -d --wait --wait-timeout 120
     sudo docker compose ps
     RELAY_DOMAIN=$(sed -n 's/^RELAY_DOMAIN=//p' .env)
     for RELAY_ATTEMPT in $(seq 1 30); do
       if RELAY_HEALTH=$(curl --fail --silent --show-error \
         --connect-timeout 3 --max-time 5 "https://$RELAY_DOMAIN/health") && \
         [ "$RELAY_HEALTH" = '{"ready":true}' ]; then
         printf 'HTTPS sain : %s/health\n' "https://$RELAY_DOMAIN"
         exit 0
       fi
       printf 'HTTPS pas encore sain (essai %s/30).\n' "$RELAY_ATTEMPT" >&2
       if [ "$RELAY_ATTEMPT" -lt 30 ]; then sleep 5; fi
     done
     printf 'Échec DNS/TLS/health : vérifier DNS, ports 80/443 et journaux filtrés ; ne pas activer Sites. Session SSH conservée.\n' >&2
     exit 1
   )
   ```

   `/health` ne consomme aucun quota fournisseur. Après succès seulement, confirmer au Codex connecté au compte du site l’activation humaine : `API_FOOTBALL_BASE_URL=https://<domaine-vérifié>/` et `API_RELAY_TOKEN` déjà saisi comme secret. Appliquer la configuration par le workflow Sites et sa version approuvée. Une erreur DNS/TLS, 401, 429 ou 502 doit être signalée comme telle, jamais comme une absence de sélection. L’essai fournisseur facultatif ci-dessous demande une autorisation séparée et un budget d’une requête.

7. **PC : vider le presse-papiers après les deux saisies.** Conserver le fichier privé pour une reprise, ou le supprimer après avoir confirmé que les deux destinations possèdent le même jeton. Ne pas l’ajouter aux livrables, au dépôt ou à une sauvegarde partagée.

   ```bash
   (
     set +x
     set -euo pipefail
     trap 'printf "Étape interrompue : commande, saisie ou fichier en échec ; corriger avant de continuer. Ne coller aucun secret dans le shell.\n" >&2' ERR
     if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v clip.exe >/dev/null; then
       printf '' | clip.exe
     elif command -v pbcopy >/dev/null; then
       printf '' | pbcopy
     elif command -v wl-copy >/dev/null; then
       wl-copy --clear
     elif command -v xclip >/dev/null; then
       printf '' | xclip -selection clipboard
     elif command -v clip.exe >/dev/null; then
       printf '' | clip.exe
     else
       printf 'Vider le presse-papiers local avant de continuer.\n' >&2
       exit 1
     fi
   )
   ```

Caddy obtient et renouvelle le certificat public grâce au DNS et aux ports 80/443. Les volumes conservent les certificats. Les deux processus sont non-root ; le relais n’a aucun port publié.

Les journaux d’accès **et runtime/erreur** de Caddy filtrent `request>headers>X-Relay-Token` et `request>headers>X-Apisports-Key` avant leur écriture. Désactiver les seuls journaux d’accès ne protège pas les erreurs. Les champs non sensibles restent disponibles, avec rotation Docker (3 fichiers de 10 Mo par service). Ne pas activer de logger supplémentaire non filtré, ni de traçage. [Référence des filtres](https://caddyserver.com/docs/caddyfile/directives/log), [logger runtime global](https://caddyserver.com/docs/caddyfile/options#log).

HSTS est explicite (`max-age=31536000`), erreurs HTTPS comprises. Ni `includeSubDomains` ni `preload` ne sont imposés au domaine parent. HSTS ne garantit pas la protection du client serveur Node : le Worker doit toujours utiliser HTTPS avec un certificat valide.

### Essai humain facultatif vers /status

Cette commande appelle réellement API-Football **une fois**, sans reprise automatique. L’exécuter seulement après autorisation du responsable et accord sur ce budget. Aucun agent ni aucune CI ne l’exécute. Elle lit la clé sans l’afficher et passe les en-têtes par l’entrée standard de curl, sans valeurs secrètes dans les arguments du processus :

```bash
(
  set +x
  set -euo pipefail
  trap 'printf "Étape interrompue : commande, saisie ou fichier en échec ; corriger avant de continuer. Ne coller aucun secret dans le shell.\n" >&2' ERR
  cd ~/footscope/deploy/relay
  source .env
  read -rsp 'Clé API-Football (non affichée) : ' API_FOOTBALL_KEY </dev/tty
  printf '\n'
  {
    printf 'x-relay-token: %s\n' "$RELAY_TOKEN"
    printf 'x-apisports-key: %s\n' "$API_FOOTBALL_KEY"
  } | curl --fail-with-body --silent --show-error --max-time 25 \
    --header @- "https://$RELAY_DOMAIN/status"
  unset API_FOOTBALL_KEY RELAY_TOKEN
)
```

Vérifier les données, les erreurs applicatives et les quotas de la réponse ; un HTTP 200 seul ne prouve pas l’accès. Ne pas publier le contenu du compte ou les clés. Ne pas utiliser `curl -v`, `set -x` ou `docker compose config` dans une sortie partagée : ils peuvent exposer les secrets.

## Configurer Sites après les vérifications humaines

Dans les secrets serveur du site FootScope existant dans Sites, poser exactement :

- `API_FOOTBALL_BASE_URL` : `https://<ip-avec-tirets>.sslip.io/` (adapter au DNS vérifié ; conserver le `/` final).
- `API_RELAY_TOKEN` : le jeton créé sur le PC à l’étape 2, identique à celui saisi à l’étape 5 sur le VPS. Recopier depuis le fichier privé du PC vers le presse-papiers avec le bloc de l’étape 2, puis coller uniquement dans la saisie sécurisée Sites. Ne jamais lire ou afficher le `.env` du VPS pour ce transfert.

Conserver `API_FOOTBALL_KEY` dans les secrets serveur Sites. L’humain applique ensuite la configuration selon le workflow de publication Sites. L’exploitant du VPS peut accéder à la clé en transit : réserver ce relais à une machine maîtrisée. Le relais refuse les routes/méthodes non autorisées et les redirections ; il ne transmet pas son jeton au fournisseur et conserve 429 et `Retry-After`.

## Validation locale et CI

`npm ci` et `npm run check` restent sans secrets. Pour tester Caddy 2.10.2 installé localement :

```bash
(
  set +x
  set -euo pipefail
  trap 'printf "Étape interrompue : commande, saisie ou fichier en échec ; corriger avant de continuer. Ne coller aucun secret dans le shell.\n" >&2' ERR
  read -rp 'Chemin du binaire Caddy 2.10.2 local : ' CADDY_BIN </dev/tty
  [ -f "$CADDY_BIN" ] && [ -x "$CADDY_BIN" ] || { printf 'Binaire Caddy absent ou non exécutable.\n' >&2; exit 1; }
  export CADDY_BIN
  node scripts/test-relay-security.mjs
)
```

Le test démarre HTTPS sur loopback avec une PKI éphémère et un fournisseur simulé, puis arrête le relais. Il recherche les valeurs fictives dans stdout/stderr et exige des journaux d’accès/erreur ainsi que HSTS sur 200/401/404/502. Avec l’ancien Caddyfile passé en argument, il échoue sur la fuite. Aucune requête fournisseur ni ACME publique.

La CI exécute aussi `bash scripts/check-relay-containers.sh` : construction des images figées, vérification des utilisateurs non-root et démarrage Compose sur localhost uniquement. Elle ne déploie rien.

## Images, mises à jour et retour arrière

Les bases Node 24.21.0 / Alpine 3.23 et Caddy 2.10.2 / Alpine sont figées par version **et digest multiarchitecture** dans les deux Dockerfiles. Le Caddy final ajoute seulement la propriété des répertoires, sans compilateur ; Node copie uniquement le script du relais et fonctionne sous `node`. La capacité de fichier livrée par l’image Caddy est retirée pour permettre son exécution avec `cap_drop: ALL`. Le sysctl du conteneur Caddy autorise ses ports bas sans capacité supplémentaire.

Pour une mise à jour : lire les notes de sécurité officielles Node/Caddy/Alpine, choisir les versions, vérifier les digests du registre officiel (`docker buildx imagetools inspect node:VERSION` et `caddy:VERSION`), modifier les deux Dockerfiles dans une PR. Si Caddy change, adapter la version exigée par le test ; si Node change, aligner la CI. Exécuter les tests locaux et la CI, puis faire approuver le SHA. Les tags majeurs mobiles ne sont pas admis. Le responsable conserve le SHA précédent et ses images avant `build --pull`, puis lance lui-même la mise à jour avec `docker compose up -d --wait`.

Retour au mode direct : l’humain retire `API_FOOTBALL_BASE_URL` et `API_RELAY_TOKEN` des secrets Sites et applique sa configuration. Cela peut réintroduire le refus de l’IP partagée. Ensuite, sur le VPS :

```bash
(
  set +x
  set -euo pipefail
  trap 'printf "Étape interrompue : commande, saisie ou fichier en échec ; corriger avant de continuer. Ne coller aucun secret dans le shell.\n" >&2' ERR
  cd ~/footscope/deploy/relay
  sudo docker compose stop
)
```

Les volumes et `.env` sont conservés. Pour reprendre, `sudo docker compose up -d --wait`. Pour revenir à une version précédente **déjà sécurisée**, recréer sur le PC l’archive du SHA précédent et refaire les deux blocs de l’étape 4, puis reconstruire et redémarrer comme ci-dessus. Ne pas revenir à l’ancien Caddyfile vulnérable ; en cas d’incident sur cette première version sécurisée, arrêter le relais et revenir au mode direct. Ne pas supprimer les volumes de certificats et ne pas desserrer les limites ou filtres de FootScope.

Les reprises du programme et des fiches restent limitées à deux essais automatiques ; un changement de date, filtre, fiche ou onglet annule la reprise, une action manuelle commence une nouvelle série.
