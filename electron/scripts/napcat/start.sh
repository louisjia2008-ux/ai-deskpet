#!/bin/zsh
# Starts NapCat for DeskPet's QQ channel. Both ports stay on this computer and the
# OneBot token is written before first boot, so it never runs unauthenticated.
# See docs/QQ_ONEBOT_SETUP.md. Secrets stay in .env, outside the repository.
set -eu
data="$HOME/Library/Application Support/DeskPet NapCat"
image='mlikiowa/napcat-docker:v4.18.42@sha256:149fae81e2ccec10e5d1be2f9f86a1a2d6e1d5c70691f892dce00b7328f2ca72'
umask 077
mkdir -p "$data/data/config" "$data/data/qq" "$data/data/plugins"
if [[ ! -f "$data/.env" ]]; then
  print -r -- "WEBUI_TOKEN=$(openssl rand -hex 24)" > "$data/.env"
  print -r -- "ONEBOT_TOKEN=$(openssl rand -hex 32)" >> "$data/.env"
fi
webui_token="$(sed -n 's/^WEBUI_TOKEN=//p' "$data/.env")"
onebot_token="$(sed -n 's/^ONEBOT_TOKEN=//p' "$data/.env")"
colima status >/dev/null 2>&1 || colima start
if [[ ! -f "$data/data/config/onebot11.json" ]]; then
  docker run --rm --entrypoint cat "$image" /app/templates/ws.json \
    | ONEBOT_TOKEN="$onebot_token" python3 -c '
import json, os, sys
config = json.load(sys.stdin)
for server in config["network"]["websocketServers"]:
    server["token"] = os.environ["ONEBOT_TOKEN"]
    server["messagePostFormat"] = "array"
    server["reportSelfMessage"] = False
json.dump(config, sys.stdout, indent=2)' > "$data/data/config/onebot11.json"
fi
if docker container inspect deskpet-napcat >/dev/null 2>&1; then
  docker start deskpet-napcat >/dev/null
else
  # A fixed MAC keeps QQ seeing the same device if the container is recreated.
  docker run -d --name deskpet-napcat --restart unless-stopped --mac-address 02:42:ac:11:00:02 \
    -e MODE=ws -e WEBUI_TOKEN="$webui_token" -e NAPCAT_UID="$(id -u)" -e NAPCAT_GID="$(id -g)" \
    -p 127.0.0.1:6099:6099 -p 127.0.0.1:3001:3001 \
    -v "$data/data/qq:/app/.config/QQ" -v "$data/data/config:/app/napcat/config" -v "$data/data/plugins:/app/napcat/plugins" \
    "$image" >/dev/null
fi
print -r -- 'NapCat is starting. Log in at http://127.0.0.1:6099/webui'
