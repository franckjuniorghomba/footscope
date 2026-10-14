#!/usr/bin/env bash
# À lancer sur le PC WSL, jamais depuis une session VPS interactive.
set +x
set -Eeuo pipefail
umask 077
trap 'printf "Installation interrompue ; corriger l’erreur avant de relancer. Aucun réglage Sites à activer.\n" >&2' ERR
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# == 1 ]] || fail 'Usage : bash scripts/relay-install.sh <IPv4-du-droplet>'
ip=$1
[[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'IPv4 invalide.'
IFS=. read -r -a octets <<< "$ip"
for octet in "${octets[@]}"; do
  [[ $octet == 0 || $octet != 0* ]] || fail 'IPv4 invalide : aucun zéro initial.'
  (( 10#$octet <= 255 )) || fail 'IPv4 invalide.'
done
domain=${ip//./-}.sslip.io
for binary in ssh scp git openssl curl flock realpath mktemp tar; do
  command -v "$binary" >/dev/null || fail "Commande requise absente : $binary"
done
repo=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
cd "$repo"
printf 'Installer le commit %s sur root@%s (%s) ?\n' "$(git rev-parse HEAD)" "$ip" "$domain"
read -r -p 'Confirmer par oui : ' confirmation || fail 'Confirmation interrompue.'
[[ $confirmation == oui ]] || fail 'Installation annulée.'
ssh_options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
if ! ssh "${ssh_options[@]}" "root@$ip" true; then
  fail 'SSH indisponible : configurer une clé/agent SSH pour root et vérifier l’empreinte du VPS dans known_hosts sur le PC. Un mot de passe seul ne suffit pas (BatchMode). Aucun jeton créé ni transféré.'
fi
# Résoudre avant toute écriture : le jeton doit rester hors du dépôt, même via un lien.
config=$(realpath -m "$HOME/.config/footscope")
case "$config/" in "$repo/"*) fail 'Le dossier privé du jeton doit être hors du dépôt.';; esac
mkdir -p "$config"
chmod 700 "$config"
[[ ! -L $config/relay-install.lock ]] || fail 'Verrou local invalide.'
exec 9>"$config/relay-install.lock"
flock -n 9 || fail 'Une installation est déjà en cours sur ce PC.'
token_file=$config/relay-token
[[ ! -L $token_file ]] || fail 'Le fichier du jeton ne doit pas être un lien symbolique.'
work=$(mktemp -d "$config/relay-install.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
if [[ ! -e $token_file ]]; then
  openssl rand -hex 32 > "$work/token"
  chmod 600 "$work/token"
  # Publication atomique sans écraser un jeton apparu entre-temps.
  ln "$work/token" "$token_file"
fi
[[ -f $token_file && -O $token_file ]] || fail 'Fichier du jeton non régulier ou non possédé par cet utilisateur.'
chmod 600 "$token_file"
token=$(< "$token_file")
export -n token
[[ $token =~ ^[0-9a-f]{64}$ ]] || fail 'Fichier du jeton invalide ; aucune rotation automatique.'
# git archive exclut tous les fichiers locaux, y compris les secrets et .workmux.
git archive --format=tar HEAD deploy/relay scripts/relay.mjs > "$work/relay.tar"
# Destination unique par exécution ; aucune archive concurrente écrasée.
remote_archive=$(ssh "${ssh_options[@]}" "root@$ip" 'umask 077; mktemp /root/footscope-relay.XXXXXXXX.tar')
[[ $remote_archive =~ ^/root/footscope-relay\.[a-zA-Z0-9]{8}\.tar$ ]] || fail 'Chemin temporaire VPS invalide.'
scp "${ssh_options[@]}" "$work/relay.tar" "root@$ip:$remote_archive"
# Le programme est lu sur stdin par bash -s. Sa dernière ligne appelle main ;
# read consomme alors la ligne suivante (jeton), jamais interprétée comme du code.
# main termine par exit, y compris en erreur via set -e.
cat > "$work/remote.sh" <<'REMOTE'
set +x
set -Eeuo pipefail
umask 077
trap 'printf "Échec sur VPS : installation arrêtée ; ne pas activer Sites.\n" >&2' ERR
main() {
  local domain=$1 archive=$2 token current expected health attempt
  IFS= read -r token
  export -n token current expected
  [[ $token =~ ^[0-9a-f]{64}$ ]] || { printf 'Jeton reçu invalide.\n' >&2; exit 1; }
  exec 8>/root/.footscope-relay-install.lock
  flock -n 8 || { printf 'Une installation est déjà en cours sur le VPS.\n' >&2; exit 1; }
  trap 'rm -f "$archive"' EXIT
  . /etc/os-release
  [[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { printf 'Ubuntu 24.04 requis ; système laissé intact.\n' >&2; exit 1; }
  mkdir -p "$HOME/footscope/deploy/relay"
  cd "$HOME/footscope/deploy/relay"
  expected=$(printf 'RELAY_DOMAIN=%s\nRELAY_TOKEN=%s' "$domain" "$token")
  if [[ -e .env || -L .env ]]; then
    [[ -f .env && ! -L .env ]] || { printf '.env non régulier ; arrêt.\n' >&2; exit 1; }
    current=$(< .env)
    [[ $current == "$expected" ]] || { printf '.env différent du domaine/jeton PC : aucune modification ; coordonner la configuration avec Sites.\n' >&2; exit 1; }
    chmod 600 .env
  else
    env_tmp=$(mktemp .env.XXXXXXXX)
    printf '%s\n' "$expected" > "$env_tmp"
    chmod 600 "$env_tmp"
    mv "$env_tmp" .env
  fi
  unset token current expected
  # Pas de mise à niveau implicite d’un Docker déjà opérationnel.
  if ! docker version >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o DPkg::Lock::Timeout=300 update
    apt-get -o DPkg::Lock::Timeout=300 install -y ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl --fail --silent --show-error --connect-timeout 10 --max-time 60 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<DOCKER
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
DOCKER
    apt-get -o DPkg::Lock::Timeout=300 update
    apt-get -o DPkg::Lock::Timeout=300 install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker
  command -v curl >/dev/null || { printf 'curl requis sur le VPS.\n' >&2; exit 1; }
  tar -xf "$archive" -C "$HOME/footscope"
  # L’archive minimale ne contient pas le .dockerignore racine. Le contexte
  # Node doit néanmoins exclure .env avant le tout premier build.
  printf '.git\n.env\n.env.*\n**/.env\n**/.env.*\nnode_modules\n.build\ndist\ncoverage\nupload\n*.zip\n' > "$HOME/footscope/.dockerignore"
  docker compose up --build -d --wait --wait-timeout 120
  for ((attempt=1; attempt<=30; attempt++)); do
    if health=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 "https://$domain/health") && [[ $health == '{"ready":true}' ]]; then
      printf 'HTTPS sain sur le VPS.\n'
      exit 0
    fi
    printf 'Attente HTTPS (%s/30).\n' "$attempt" >&2
    if (( attempt < 30 )); then sleep 5; fi
  done
  printf 'HTTPS indisponible après 30 essais : vérifier DNS et ports 80/443 ; ne pas activer Sites.\n' >&2
  exit 1
}
main "$@"
REMOTE
{ cat "$work/remote.sh"; printf '%s\n' "$token"; } | ssh "${ssh_options[@]}" "root@$ip" "bash -s -- $domain $remote_archive"
unset token
health=$(curl --fail --silent --show-error --connect-timeout 3 --max-time 10 "https://$domain/health")
[[ $health == '{"ready":true}' ]] || fail 'Santé HTTPS invalide depuis le PC ; ne pas activer Sites.'
printf 'HTTPS vérifié depuis le PC. Réglages serveur Sites :\nAPI_FOOTBALL_BASE_URL=https://%s/\nAPI_RELAY_TOKEN (secret)\n' "$domain"
if command -v clip.exe >/dev/null; then
  clip.exe < "$token_file"
  printf 'Jeton copié dans Windows : le coller une seule fois dans la saisie sécurisée de secret du Codex connecté au compte du site, puis vider le presse-papiers.\n'
else
  printf 'clip.exe absent : activer l’interopérabilité Windows de WSL, puis relancer cette même commande. Le jeton sera réutilisé ; aucun secret à afficher ou copier manuellement.\n' >&2
fi
