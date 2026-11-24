#!/usr/bin/env bash
# Serves Zelkaro's evidence site on the existing Lightsail server (the one already
# running Detour/Tacitum behind Caddy). Zelkaro's site is static (the docs/ folder),
# so Caddy serves the files directly — no Node service needed.
#
# Run ON the server (Lightsail "Connect using SSH"):
#   curl -fsSL https://raw.githubusercontent.com/tomcode1000/zelkaro/main/deploy/lightsail-zelkaro.sh | bash
#
# What it does, without touching Detour or Tacitum:
#   - clones github.com/tomcode1000/zelkaro to /opt/zelkaro (or pulls latest)
#   - APPENDS one static site to Caddy (HTTPS via Let's Encrypt), validates, and
#     restores the old Caddyfile if validation fails
set -euo pipefail

APP=/opt/zelkaro
IP_DASHED="$(curl -fsS https://checkip.amazonaws.com | tr -d '\n' | tr . -)"
SITE="${ZELKARO_SITE:-zelkaro.${IP_DASHED}.sslip.io}"
echo "site: https://$SITE"

command -v caddy >/dev/null || { echo "Caddy is not installed; run Detour's lightsail-setup.sh first."; exit 1; }
command -v git >/dev/null || sudo apt-get install -y git

if [ ! -d "$APP/.git" ]; then
  sudo git clone https://github.com/tomcode1000/zelkaro.git "$APP"
  sudo chown -R "$USER":"$USER" "$APP"
else
  git -C "$APP" pull --ff-only
fi

# Caddy: append our static site once, validate, roll back on failure.
CF=/etc/caddy/Caddyfile
if ! grep -q "$SITE" "$CF"; then
  sudo cp "$CF" "$CF.bak-zelkaro-$(date +%s)"
  sudo tee -a "$CF" >/dev/null <<CADDY

# --- Zelkaro (added by deploy/lightsail-zelkaro.sh) ---
$SITE {
  encode gzip
  root * $APP/docs
  file_server
}
CADDY
  if sudo caddy validate --adapter caddyfile --config "$CF"; then
    sudo systemctl reload caddy
    echo "added $SITE to Caddy and reloaded"
  else
    echo "Caddyfile validation FAILED — restoring previous Caddyfile"
    sudo cp "$(ls -t $CF.bak-zelkaro-* | head -1)" "$CF"
    exit 1
  fi
else
  echo "$SITE already in Caddy; reloading in case files changed"
  sudo systemctl reload caddy
fi

echo
echo "Done. Live at: https://$SITE"
echo "To update later:  git -C $APP pull && sudo systemctl reload caddy"
