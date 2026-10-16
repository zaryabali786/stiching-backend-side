#!/usr/bin/env bash
# ONE-TIME setup of a fresh Ubuntu / Debian server (Contabo). Run it as root:
#
#   DEPLOY_PUBKEY="ssh-ed25519 AAAA... github-deploy" DOMAIN="api.example.com" bash setup-server.sh
#
#   DEPLOY_PUBKEY  required  the PUBLIC key whose private half is the SSH_PRIVATE_KEY secret in GitHub
#   DOMAIN         optional  your API domain (its A record must already point to this server): adds HTTPS (Let's Encrypt)
#   CERT_EMAIL     optional  email for certificate notices
#   SSH_PORT       optional  default 22
#
# Safe to run again: every step checks what is already there.
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "Run as root." >&2; exit 1; }
: "${DEPLOY_PUBKEY:?Set DEPLOY_PUBKEY to the public SSH key for GitHub deploys}"
DOMAIN="${DOMAIN:-}"
SSH_PORT="${SSH_PORT:-22}"
APP_DIR=/var/www/backend
DEPLOY_USER=deploy

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git nginx ufw rsync ca-certificates

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2

echo "==> Deploy user"
id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
grep -qxF "$DEPLOY_PUBKEY" "/home/$DEPLOY_USER/.ssh/authorized_keys" 2>/dev/null || echo "$DEPLOY_PUBKEY" >> "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"

echo "==> App folder $APP_DIR"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"

echo "==> PM2 starts on boot (as $DEPLOY_USER)"
env PATH="$PATH" pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER" >/dev/null

echo "==> Nginx"
NAME="${DOMAIN:-_}"
cat > /etc/nginx/sites-available/backend <<NGINX
server {
    listen 80;
    server_name ${NAME};
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/backend /etc/nginx/sites-enabled/backend
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> Firewall"
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

if [ -n "$DOMAIN" ]; then
  echo "==> HTTPS for $DOMAIN"
  apt-get install -y certbot python3-certbot-nginx
  if [ -n "${CERT_EMAIL:-}" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$CERT_EMAIL"
  else
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --register-unsafely-without-email
  fi
fi

cat <<DONE

Server is ready. Next:
  1. Create the environment file:  nano $APP_DIR/.env
     then:  chown $DEPLOY_USER:$DEPLOY_USER $APP_DIR/.env && chmod 600 $APP_DIR/.env
  2. Push to main on GitHub: the CI/CD job uploads the code and starts the app.
DONE
