#!/bin/sh
# Koppelt de Tailscale-sidecar interactief aan je tailnet, zonder auth-key.
#
# Waarom een apart script: de sidecar (containerboot) geeft een interactieve
# login maar 60 seconden. Daarna stopt hij, herstart, en is de inloglink weer
# ongeldig. Dit script zet de sidecar even stil en draait tailscaled los, met
# dezelfde statusmap, en wacht zonder tijdslimiet tot je de link hebt geopend.
# Daarna start de sidecar gewoon weer, al ingelogd.
#
# Alternatief zonder dit script: TS_AUTHKEY in tailscale.env (zie README).
set -eu
cd "$(dirname "$0")"
NAAM=regiochecker-tailscale-login

docker compose stop tailscale >/dev/null
docker rm -f "$NAAM" >/dev/null 2>&1 || true
mkdir -p tailscale
docker run -d --name "$NAAM" -v "$PWD/tailscale:/var/lib/tailscale" tailscale/tailscale:stable \
  sh -c 'tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale --socket=/tmp/ts.sock >/dev/null 2>&1 &
         sleep 3
         tailscale --socket=/tmp/ts.sock login --hostname=regiochecker --timeout=0' >/dev/null

echo "Wachten op de inloglink…"
LINK=""
for _ in $(seq 1 30); do
  LINK=$(docker logs "$NAAM" 2>&1 | grep -o 'https://login.tailscale.com/a/[A-Za-z0-9]*' | tail -1 || true)
  [ -n "$LINK" ] && break
  sleep 1
done
if [ -z "$LINK" ]; then
  echo "Geen link gekregen. Logboek:"; docker logs "$NAAM"; docker rm -f "$NAAM" >/dev/null
  docker compose up -d tailscale >/dev/null; exit 1
fi
echo "Open deze link en log in met je Tailscale-account:"
echo "  $LINK"
echo "Dit script wacht tot dat gelukt is…"

docker wait "$NAAM" >/dev/null
docker logs "$NAAM" 2>&1 | tail -2
docker rm "$NAAM" >/dev/null
docker compose up -d tailscale >/dev/null
echo "Klaar: de sidecar draait weer, nu ingelogd als 'regiochecker'."
