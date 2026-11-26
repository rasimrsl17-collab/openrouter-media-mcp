#!/usr/bin/env bash
# Installs the openrouter-media MCP next to a Docker-based LibreChat
# (deploy-compose layout: LibreChat-API + LibreChat-NGINX containers).
#
# What it does (backups first, automatic rollback if a check fails):
#   1. builds the image and runs it as its own container on LibreChat's Docker network
#   2. adds the server to librechat.yaml (mcpServers + mcpSettings.allowedAddresses)
#   3. adds a /mcp-media/media/ location to the nginx config and reloads nginx
#   4. restarts LibreChat-API and checks everything
#
# Usage:  bash openrouter-media-mcp/deploy/install-librechat-docker.sh
# Safe to run again (already-present parts are skipped; the container is rebuilt).

set -euo pipefail

LC_DIR="${LC_DIR:-/root/LibreChat}"
API_CONTAINER="${API_CONTAINER:-LibreChat-API}"
NGINX_CONTAINER="${NGINX_CONTAINER:-LibreChat-NGINX}"
YAML="${YAML:-$LC_DIR/librechat.yaml}"
NGINX_CONF="${NGINX_CONF:-$LC_DIR/nginx-ssl/default.conf}"
MCP_DIR="$LC_DIR/openrouter-media-mcp"
NAME="openrouter-media"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ---------- pre-checks ----------
step "0/5 Yoxlamalar"
for f in "$MCP_DIR/.env" "$YAML" "$NGINX_CONF"; do
  [ -f "$f" ] || { red "Fayl tapılmadı: $f"; exit 1; }
done
for c in "$API_CONTAINER" "$NGINX_CONTAINER"; do
  docker inspect "$c" >/dev/null 2>&1 || { red "Konteyner tapılmadı: $c"; exit 1; }
done
env_val() { grep -E "^$1=" "$MCP_DIR/.env" | tail -1 | cut -d= -f2-; }
KEY="$(env_val OPENROUTER_API_KEY)"
SECRET="$(env_val MCP_SHARED_SECRET)"
PUBLIC="$(env_val PUBLIC_BASE_URL)"
if [ -z "$KEY" ] || [ "$KEY" = "sk-or-v1-..." ]; then red ".env: OPENROUTER_API_KEY doldurulmayıb"; exit 1; fi
if [ -z "$SECRET" ] || [ "$SECRET" = "change-me" ] || [ "${#SECRET}" -lt 32 ]; then red ".env: MCP_SHARED_SECRET doldurulmayıb"; exit 1; fi
case "$PUBLIC" in https://*) ;; *) red ".env: PUBLIC_BASE_URL https:// ilə başlamalıdır"; exit 1;; esac
green "OK"

TS="$(date +%Y%m%d-%H%M%S)"
cp -p "$YAML" "$YAML.bak-$TS"
cp -p "$NGINX_CONF" "$NGINX_CONF.bak-$TS"
echo "Backup: $YAML.bak-$TS"
echo "Backup: $NGINX_CONF.bak-$TS"
# restore by overwriting content (keeps the inode, so bind-mounted containers see it)
restore_yaml() { cat "$YAML.bak-$TS" > "$YAML"; red "librechat.yaml geri qaytarıldı"; }
restore_nginx() { cat "$NGINX_CONF.bak-$TS" > "$NGINX_CONF"; red "nginx konfiqi geri qaytarıldı"; }

# ---------- 1. image + container ----------
step "1/5 Docker image qurulur"
docker build -t "$NAME" "$MCP_DIR"

step "2/5 Konteyner LibreChat şəbəkəsində işə salınır"
NET="$(docker inspect "$API_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')"
echo "Şəbəkə: $NET"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --network "$NET" \
  --env-file "$MCP_DIR/.env" \
  -v openrouter-media-data:/data \
  --restart unless-stopped \
  "$NAME" >/dev/null
# note: capture logs first; `docker logs | grep -q` fails under pipefail (SIGPIPE)
STARTED=no
for i in $(seq 1 20); do
  LOGS="$(docker logs "$NAME" 2>&1 || true)"
  if [[ "$LOGS" == *"listening on"* ]]; then STARTED=yes; break; fi
  sleep 1
done
printf '%s\n' "$LOGS" | tail -5
if [ "$STARTED" != yes ]; then red "MCP server başlamadı (yuxarıdakı loqa bax)"; exit 1; fi
green "OK"

# ---------- 2. librechat.yaml ----------
step "3/5 librechat.yaml"
python3 - "$YAML" "$SECRET" <<'PY'
import re, sys
path, secret = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
lines = text.split("\n")

server_block = [
    "  openrouter-media:",
    "    type: streamable-http",
    "    url: http://openrouter-media:3400/mcp",
    "    headers:",
    f'      X-API-Key: "{secret}"',
    # chat-only header: LibreChat omits requestHeaders during startup tool discovery,
    # so a user placeholder here does not block tool listing (see data-provider mcp.ts)
    "    requestHeaders:",
    '      X-User-ID: "{{LIBRECHAT_USER_ID}}"',
    "    timeout: 300000",
    "    initTimeout: 30000",
    "    chatMenu: false",
    "    serverInstructions: false",
]

if re.search(r"^  openrouter-media:\s*$", text, re.M):
    # migrate v1 config: X-User-ID under `headers` blocks startup tool discovery
    old = '\n      X-User-ID: "{{LIBRECHAT_USER_ID}}"'
    if old in text and "\n    requestHeaders:" + old not in text:
        text = text.replace(old, "\n    requestHeaders:" + old, 1)
        lines = text.split("\n")
        print("openrouter-media: X-User-ID requestHeaders-ə köçürüldü")
    else:
        print("mcpServers.openrouter-media artıq var — keçildi")
else:
    idx = [i for i, l in enumerate(lines) if re.match(r"^mcpServers:\s*(#.*)?$", l)]
    if len(idx) == 1:
        lines[idx[0] + 1 : idx[0] + 1] = server_block
        print("mcpServers altına openrouter-media əlavə edildi")
    elif not idx:
        lines += ["", "mcpServers:"] + server_block
        print("mcpServers bölməsi yaradıldı")
    else:
        sys.exit("XƏTA: faylda bir neçə üst səviyyə 'mcpServers:' var")

text = "\n".join(lines)
if re.search(r"^mcpSettings:", text, re.M):
    if "openrouter-media:3400" in text:
        print("mcpSettings artıq hazırdır — keçildi")
    else:
        sys.exit("XƏTA: mcpSettings artıq var; allowedAddresses-ə 'openrouter-media:3400' əl ilə əlavə et")
else:
    if not text.endswith("\n"):
        text += "\n"
    text += '\nmcpSettings:\n  allowedAddresses:\n    - "openrouter-media:3400"\n'
    print("mcpSettings.allowedAddresses əlavə edildi")

# write in place (same inode) so the bind mount in the container sees the change
with open(path, "r+", encoding="utf-8") as f:
    f.seek(0)
    f.write(text)
    f.truncate()
PY

# validate YAML
if python3 -c "import yaml" 2>/dev/null; then
  if ! python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" "$YAML"; then
    restore_yaml; exit 1
  fi
elif ! docker exec "$API_CONTAINER" node -e "require('js-yaml').load(require('fs').readFileSync('/app/librechat.yaml','utf8'))" 2>/dev/null; then
  red "YAML yoxlanıla bilmədi (nə PyYAML, nə də konteynerdə js-yaml tapıldı) — davam edilir"
fi
green "OK"

# ---------- 3. nginx ----------
step "4/5 nginx"
python3 - "$NGINX_CONF" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
if "location /mcp-media/media/" in text:
    print("nginx bloku artıq var — keçildi")
    sys.exit(0)
m = re.search(r"^([ \t]*)location /oauth/ \{", text, re.M)
if not m:
    m = re.search(r"^([ \t]*)location / \{", text, re.M)
if not m:
    sys.exit("XƏTA: nginx konfiqində 'location /oauth/' və ya 'location /' tapılmadı")
ind = m.group(1)
block = "\n".join(ind + l if l else l for l in [
    "# openrouter-media MCP: generated videos/audio/images (only /media is public)",
    "location /mcp-media/media/ {",
    "    resolver 127.0.0.11 valid=10s;",
    "    set $media_up http://openrouter-media:3400;",
    "    rewrite ^/mcp-media(/media/.*)$ $1 break;",
    "    proxy_pass $media_up;",
    "    proxy_set_header Host $host;",
    "    proxy_set_header Range $http_range;",
    "    proxy_set_header If-Range $http_if_range;",
    "    proxy_buffering off;",
    "}",
    "",
    "",
])
text = text[: m.start()] + block + text[m.start():]
with open(path, "r+", encoding="utf-8") as f:
    f.seek(0)
    f.write(text)
    f.truncate()
print("nginx-ə /mcp-media/media/ əlavə edildi")
PY
if ! docker exec "$NGINX_CONTAINER" nginx -t; then
  restore_nginx; exit 1
fi
docker exec "$NGINX_CONTAINER" nginx -s reload
green "OK"

# ---------- 4. restart + checks ----------
step "5/5 LibreChat-API yenidən başladılır"
docker restart "$API_CONTAINER" >/dev/null
echo "LibreChat-ın açılması gözlənilir (60 saniyəyə qədər)..."
API_LOGS=""
for i in $(seq 1 30); do
  API_LOGS="$(docker logs --since 3m "$API_CONTAINER" 2>&1 || true)"
  if [[ "${API_LOGS,,}" == *"openrouter-media"* ]]; then break; fi
  sleep 2
done
echo "--- LibreChat loqunda openrouter-media:"
printf '%s\n' "$API_LOGS" | grep -i "openrouter-media" | tail -6 || true

echo "--- Public media yolu:"
BODY="$(curl -s -m 15 "$PUBLIC/media/install-check" || true)"
if [[ "$BODY" == *"Cannot GET /media/install-check"* ]]; then
  green "OK — $PUBLIC/media/ MCP serverə çatır"
else
  red "Gözlənilən cavab gəlmədi: $(echo "$BODY" | head -c 200)"
fi

echo
green "Hazırdır. Problem olsa geri qaytarmaq üçün:"
echo "  cat $YAML.bak-$TS > $YAML && cat $NGINX_CONF.bak-$TS > $NGINX_CONF"
echo "  docker exec $NGINX_CONTAINER nginx -s reload && docker restart $API_CONTAINER && docker rm -f $NAME"
