# Deploying the backend to Contabo (CI/CD)

Every push to `main` runs the tests. If they pass, GitHub uploads the code to the server over SSH, installs the packages
and reloads the app with PM2. A pull request only runs the tests.

```
git push  ->  GitHub Actions: npm run test:unit  ->  rsync to /var/www/backend  ->  deploy/deploy.sh  ->  pm2 reload  ->  /api/health check
```

The database stays on Supabase. The server only runs the Node.js app (behind Nginx).

## One-time setup

### 1. Make an SSH key just for GitHub deploys (on your own computer)
```
ssh-keygen -t ed25519 -f contabo_deploy -C "github-deploy" -N ""
```
This makes two files: `contabo_deploy` (private, secret) and `contabo_deploy.pub` (public).

### 2. Prepare the server (once)
Log in as root and run the setup script. It installs Node 22, PM2, Nginx and the firewall, creates a `deploy` user and
adds your public key to it.
```
ssh root@YOUR_SERVER_IP
curl -fsSL https://raw.githubusercontent.com/zaryabali786/stiching-backend-side/main/deploy/setup-server.sh -o setup-server.sh
# if the repo is private, copy the file from this repo to the server with scp instead
DEPLOY_PUBKEY="$(paste the content of contabo_deploy.pub here)" DOMAIN="api.yourdomain.com" bash setup-server.sh
```
- `DOMAIN` is optional. Leave it out to use the server by IP only (HTTP). With a domain the script also gets an HTTPS
  certificate; point the domain's **A record** to the server IP first.
- A private repository: copy the script over from your computer, `scp deploy/setup-server.sh root@YOUR_SERVER_IP:`.

### 3. Create the environment file on the server
The secrets never go to GitHub. Copy the values from your local `backend/.env` (use `.env.example` as the list):
```
nano /var/www/backend/.env
chown deploy:deploy /var/www/backend/.env && chmod 600 /var/www/backend/.env
```
Set `NODE_ENV=production` and `PORT=5000`.

### 4. Add the secrets in GitHub
Repository **Settings -> Secrets and variables -> Actions -> New repository secret**:

| Secret | Value |
|---|---|
| `SERVER_HOST` | the server IP or domain |
| `SERVER_USER` | `deploy` |
| `SSH_PRIVATE_KEY` | the full content of the `contabo_deploy` file (private key) |
| `SERVER_PORT` | optional, only if SSH is not on 22 |

Until the three required secrets exist, the deploy job is skipped with a warning (the tests still run).

### 5. First deploy
Push to `main`, or open the **Actions** tab, choose **CI/CD** and press **Run workflow**. When it is green, check:
```
curl http://YOUR_SERVER_IP/api/health          # or https://api.yourdomain.com/api/health
```

## Every day
Just `git push` to `main`. Look at the **Actions** tab to see the result.

On the server:
```
sudo -u deploy pm2 status
sudo -u deploy pm2 logs stitching-backend --lines 100
sudo -u deploy pm2 restart stitching-backend
```

## After the backend is live
- Point the customer app and the admin portal `apiUrl` to `https://api.yourdomain.com/api` and build them for production.
- Update the Postmark inbound webhook, the Stripe webhook and the Google login origins to the new address.
- CORS is currently open to every origin (`src/app.js`). When the final domains are known, restrict it to them.

## If a deploy fails
- Red **Test** job: a test failed; fix it and push again. Nothing was deployed.
- Red **Deploy** job: open its log. Most common causes: the secrets are wrong, `/var/www/backend/.env` is missing, or
  the app crashed on start (the log shows the last 40 PM2 lines).
