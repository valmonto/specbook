# Deployment

Every push to `main` auto-deploys to the VM (e.g. a Hetzner server). GitHub Actions SSHes in,
resets the checkout to `main`, and rebuilds the Docker stack.

- Workflow: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
- Stack: [`compose.staging.yml`](compose.staging.yml) — Postgres, Redis, a one-shot `migrate`
  runner, `api` (scalable), `web`, `worker`.

```
git push main → Actions → ssh → cd /opt/specbook && git fetch origin main && git reset --hard FETCH_HEAD && docker compose -f compose.staging.yml up -d --build
```

**`/opt/specbook` on the VM is a mirror of `main`, not a working copy.** The deploy
resets to `FETCH_HEAD` rather than merging, and anything edited on the box is
discarded on the next deploy — the repo is the only source of what runs. A merge
can fail (diverged branch, local edits, a conflict) and silently leave the tree on
old code; a reset cannot. The remote script also runs with `script_stop: true`, so
a failure there makes the deploy RED instead of rebuilding stale code and reporting
green. The deploy log prints the SHA it shipped, so "is my merge live?" is
answerable from Actions instead of by probing production.

Ports bind to **`127.0.0.1` only** — put a reverse proxy in front:
web `3010`, api `3011`–`3015` (one per replica).

## One-time server setup

```bash
# 1. Provision an Ubuntu VM, create a deploy user
adduser deploy && usermod -aG sudo deploy

# 2. Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy   # log out/in after

# 3. Clone to /opt/specbook (path is hardcoded in deploy.yml)
sudo mkdir -p /opt/specbook && sudo chown deploy:deploy /opt/specbook
git clone git@github.com:<org>/<repo>.git /opt/specbook
```

**No GitHub credentials are needed on the server.** The workflow passes its own
run-scoped token into the fetch, so the box never stores a deploy key or password
that can silently expire. (It used to need one — and when the server's `origin`
ended up an HTTPS URL with no credentials, every fetch died with `could not read
Username for 'https://github.com'` and deploys reported green for weeks while
shipping nothing. Sourcing the URL from the workflow removes that failure mode.)

**4. Create `.env`** in the repo root (git-ignored, server-only). Required keys:

```dotenv
DB_USER=specbook
DB_NAME=specbook
DB_PASSWORD=<openssl rand -hex 32>
REDIS_PASSWORD=<secret>
REDIS_HOST=redis
REDIS_PORT=6379
IAM_REDIS_HOST=redis
IAM_REDIS_PORT=6379
IAM_REDIS_PASSWORD=<same as REDIS_PASSWORD>
IAM_JWT_SECRET=<secret>
IAM_COOKIE_SECRET=<secret>
SEED_INITIAL_EMAIL=admin@example.com
SEED_INITIAL_PASSWORD=<secret>
SEED_INITIAL_NAME=Admin
SEED_INITIAL_ORG_NAME=Acme
```

**5. Reverse proxy + TLS** (Caddy → auto Let's Encrypt). Point DNS at the server first.

```caddyfile
yourdomain.com {
    handle_path /api/* { reverse_proxy 127.0.0.1:3011 127.0.0.1:3012 }
    handle { reverse_proxy 127.0.0.1:3010 }
}
```

**6. First boot:** `docker compose -f compose.staging.yml up -d --build`

## GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions:

| Secret            | Value                                              |
| ----------------- | -------------------------------------------------- |
| `SSH_HOST`        | server IP/hostname                                 |
| `SSH_USER`        | `deploy`                                           |
| `SSH_PRIVATE_KEY` | private key whose public half is in `~deploy/.ssh/authorized_keys` |

```bash
ssh-keygen -t ed25519 -f gh_deploy_key -N ""
ssh-copy-id -i gh_deploy_key.pub deploy@<server-ip>
cat gh_deploy_key   # paste into SSH_PRIVATE_KEY
```

Done — pushes to `main` now deploy. Watch the **Actions** tab.

## Operations

Run from `/opt/specbook`:

```bash
docker compose -f compose.staging.yml ps                       # status
docker compose -f compose.staging.yml logs -f api worker       # logs
docker compose -f compose.staging.yml up -d --build            # manual redeploy
docker compose -f compose.staging.yml up -d --scale api=3      # scale (max 5; update proxy)
docker compose -f compose.staging.yml run --rm migrate         # run migrations manually
docker compose -f compose.staging.yml down                     # stop (add -v to wipe volumes)

# DB backup (volume: specbookdb_data)
docker compose -f compose.staging.yml exec -T postgres \
  pg_dump -U specbook specbook | gzip > backup-$(date +%F).sql.gz
```

## Troubleshooting

- **SSH step fails** — check `SSH_*` secrets; test `ssh deploy@<host>`.
- **`migrate` exits non-zero** — api/worker won't start (they depend on it). Check its logs.
- **502 from proxy** — container down or wrong loopback port (`docker compose ps`).
- **Disk full** — `docker image prune -af && docker builder prune`.
