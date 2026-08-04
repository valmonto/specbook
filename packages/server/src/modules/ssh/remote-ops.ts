/**
 * The named, versioned remote operations — the ONLY scripts that ever run
 * over SSH. Each is idempotent: re-running after a dropped connection is
 * always safe. Ad-hoc command strings never cross the wire; adding an op
 * means adding it HERE, reviewed like any other code.
 */
export const REMOTE_OPS = {
  /** v1: create the directories named on stdin (one per line). */
  'ensure-dirs': `#!/usr/bin/env bash
set -euo pipefail
while IFS= read -r dir; do
  [ -n "$dir" ] && mkdir -p -- "$dir"
done
echo "ensure-dirs: ok"
`,
  /** v1: probe $1 until it answers 2xx or attempts run out (read-only). */
  'health-check': `#!/usr/bin/env bash
set -euo pipefail
url="\${1:?usage: health-check <url>}"
for _ in $(seq 1 10); do
  if curl -fsS -o /dev/null -m 5 "$url"; then
    echo "health-check: ok"
    exit 0
  fi
  sleep 3
done
echo "health-check: FAILED for $url" >&2
exit 1
`,

  /**
   * v1: ensure the shared data plane exists on this box — the docker network
   * apps will join, and one shared Postgres with a persistent volume. Root
   * password arrives as the single stdin line and is used only on FIRST
   * creation; nothing is published on any host port (container-network only).
   */
  'data-plane-ensure': `#!/usr/bin/env bash
set -euo pipefail
# The whole body is one { } group: bash parses it fully BEFORE executing, so
# the read consumes the trailing DATA line, never the next script line.
{
  IFS= read -r root_pw
  [ -n "$root_pw" ] || { echo "data-plane-ensure: missing password on stdin" >&2; exit 1; }
  docker network inspect specbook-data >/dev/null 2>&1 || docker network create specbook-data >/dev/null
  if ! docker inspect specbook-postgres >/dev/null 2>&1; then
    docker run -d --name specbook-postgres --restart unless-stopped \\
      --network specbook-data \\
      -e POSTGRES_USER=specbook -e POSTGRES_PASSWORD="$root_pw" -e POSTGRES_DB=specbook \\
      -v specbook-pgdata:/var/lib/postgresql \\
      postgres:18 >/dev/null
  fi
  docker start specbook-postgres >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    if docker exec specbook-postgres pg_isready -U specbook >/dev/null 2>&1; then
      # Unit roles must reach ONLY their own database: close the default
      # PUBLIC connect on the shared/system databases (idempotent).
      docker exec specbook-postgres psql -U specbook -v ON_ERROR_STOP=1 -tA \
        -c "REVOKE CONNECT ON DATABASE specbook FROM PUBLIC" \
        -c "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC" >/dev/null
      echo "data-plane-ensure: ok"
      exit 0
    fi
    sleep 2
  done
  echo "data-plane-ensure: postgres not ready" >&2
  exit 1
}
`,

  /**
   * v1: provision one environment's isolated unit: a Postgres role+database
   * named $1 (strictly validated) and a dedicated Redis container on the
   * data network. Role password arrives as the single stdin line; CREATE or
   * ALTER makes the run idempotent AND self-healing after half-failures.
   */
  'data-plane-provision-unit': `#!/usr/bin/env bash
set -euo pipefail
unit="\${1:?usage: data-plane-provision-unit <unit>}"
# One parsed { } group — see data-plane-ensure for why the read is safe here.
{
  [[ "$unit" =~ ^[a-z][a-z0-9_]{0,47}$ ]] || { echo "invalid unit name" >&2; exit 1; }
  IFS= read -r unit_pw
  [ -n "$unit_pw" ] || { echo "provision-unit: missing password on stdin" >&2; exit 1; }
  pgx() { docker exec specbook-postgres psql -U specbook -v ON_ERROR_STOP=1 -tA -c "$1"; }
  if [ "$(pgx "SELECT 1 FROM pg_roles WHERE rolname='$unit'")" = "1" ]; then
    pgx "ALTER ROLE \\"$unit\\" LOGIN PASSWORD '$unit_pw'" >/dev/null
  else
    pgx "CREATE ROLE \\"$unit\\" LOGIN PASSWORD '$unit_pw'" >/dev/null
  fi
  if [ "$(pgx "SELECT 1 FROM pg_database WHERE datname='$unit'")" != "1" ]; then
    pgx "CREATE DATABASE \\"$unit\\" OWNER \\"$unit\\"" >/dev/null
    pgx "REVOKE CONNECT ON DATABASE \\"$unit\\" FROM PUBLIC" >/dev/null
  fi
  if ! docker inspect "specbook-redis-$unit" >/dev/null 2>&1; then
    docker run -d --name "specbook-redis-$unit" --restart unless-stopped \\
      --network specbook-data redis:8-alpine redis-server --appendonly yes >/dev/null
  fi
  docker start "specbook-redis-$unit" >/dev/null 2>&1 || true
  echo "provision-unit: ok"
  exit 0
}
`,

  /**
   * v1: ensure the ingress plane exists on this box — the shared network
   * environment proxies join, the vhost directory, and one Caddy container
   * owning ports 80/443 (the box's ONLY public listener for domained
   * environments). Certificates live on the specbook-caddy-data volume and
   * Caddy issues/renews them itself; nothing here touches Let's Encrypt.
   */
  'ensure-caddy': `#!/usr/bin/env bash
set -euo pipefail
docker network inspect specbook-ingress >/dev/null 2>&1 || docker network create specbook-ingress >/dev/null
mkdir -p "$HOME/specbook-caddy/sites"
if [ ! -f "$HOME/specbook-caddy/Caddyfile" ]; then
  printf 'import /etc/caddy/sites/*.caddy\\n' > "$HOME/specbook-caddy/Caddyfile"
fi
if ! docker inspect specbook-caddy >/dev/null 2>&1; then
  docker run -d --name specbook-caddy --restart unless-stopped \\
    --network specbook-ingress \\
    -p 80:80 -p 443:443 \\
    -v "$HOME/specbook-caddy/Caddyfile":/etc/caddy/Caddyfile:ro \\
    -v "$HOME/specbook-caddy/sites":/etc/caddy/sites:ro \\
    -v specbook-caddy-data:/data \\
    caddy:2-alpine >/dev/null
fi
docker start specbook-caddy >/dev/null 2>&1 || true
echo "ensure-caddy: ok"
`,

  /**
   * v1: prove $1 resolves to the same address(es) as $2 (this server), so a
   * deploy fails fast with a named cause instead of succeeding into a dead
   * URL while ACME retries in the background. Read-only. A Cloudflare
   * orange-cloud domain fails here BY DESIGN — grey-cloud only.
   */
  'dns-points-at': `#!/usr/bin/env bash
set -euo pipefail
domain="\${1:?usage: dns-points-at <domain> <expected-host>}"
expected="\${2:?usage: dns-points-at <domain> <expected-host>}"
[[ "$domain" =~ ^[a-z0-9.-]+$ ]] || { echo "invalid domain" >&2; exit 1; }
got=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u)
[ -n "$got" ] || { echo "dns-points-at: $domain does not resolve" >&2; exit 1; }
want=$(getent ahostsv4 "$expected" 2>/dev/null | awk '{print $1}' | sort -u)
if [ -z "$(comm -12 <(echo "$got") <(echo "$want"))" ]; then
  echo "dns-points-at: $domain does not resolve to this server (got: $(echo $got), expected: $(echo $want))" >&2
  exit 1
fi
echo "dns-points-at: ok"
`,

  /**
   * v1: print the HEAD sha of a branch. The repo URL arrives on stdin (it
   * may embed a short-lived token — never in argv, never in ps).
   */
  'resolve-head-sha': `#!/usr/bin/env bash
set -euo pipefail
branch="\${1:?usage: resolve-head-sha <branch>}"
{
  IFS= read -r repo_url
  [ -n "$repo_url" ] || { echo "resolve-head-sha: missing url on stdin" >&2; exit 1; }
  sha=$(git ls-remote "$repo_url" "refs/heads/$branch" | awk '{print $1}' | head -n1)
  [ -n "$sha" ] || { echo "resolve-head-sha: branch not found: $branch" >&2; exit 1; }
  echo "$sha"
  exit 0
}
`,

  /**
   * v1: build the valmatic-convention images for one unit at one sha —
   * shallow-fetch the commit, docker build every apps/{api,worker,web}
   * Dockerfile present (api+web required), tag <unit>-<app>:<sha>, keep the
   * last 3 shas per image, clean the checkout. Serial on purpose: small
   * boxes. Clone URL (may embed a token) arrives on stdin.
   */
  'build-images': `#!/usr/bin/env bash
set -euo pipefail
unit="\${1:?usage: build-images <unit> <sha>}"
sha="\${2:?usage: build-images <unit> <sha>}"
{
  [[ "$unit" =~ ^[a-z][a-z0-9_]{0,47}$ ]] || { echo "invalid unit name" >&2; exit 1; }
  [[ "$sha" =~ ^[0-9a-f]{7,64}$ ]] || { echo "invalid sha" >&2; exit 1; }
  IFS= read -r repo_url
  [ -n "$repo_url" ] || { echo "build-images: missing url on stdin" >&2; exit 1; }
  work="$HOME/specbook-build/$unit"
  rm -rf "$work" && mkdir -p "$work" && cd "$work"
  git init -q . && git fetch -q --depth 1 "$repo_url" "$sha" && git checkout -q FETCH_HEAD
  if [ ! -f apps/api/Dockerfile ] || [ ! -f apps/web/Dockerfile ]; then
    echo "SHAPE_INVALID: repo is not valmatic-shaped (apps/{api,web}/Dockerfile required)" >&2
    exit 3
  fi
  built=""
  for app in api worker web; do
    if [ -f "apps/$app/Dockerfile" ]; then
      # Not quiet ON PURPOSE: this output IS the deployment log's build phase.
      echo "== building $unit-$app:$sha =="
      docker build -f "apps/$app/Dockerfile" -t "$unit-$app:$sha" .
      built="$built$app,"
    fi
  done
  for app in api worker web; do
    docker image ls --format '{{.Repository}}:{{.Tag}}' "$unit-$app" | tail -n +4 | xargs -r docker rmi >/dev/null 2>&1 || true
  done
  cd / && rm -rf "$work"
  echo "build-images: ok apps=\${built%,}"
  exit 0
}
`,

  /**
   * v1: bring the rendered stack up and gate on health. Compose files were
   * SFTP'd beforehand; --wait rides the api healthcheck, and a final probe
   * proves the whole chain: through the published proxy port, or — when a
   * domain is given — through Caddy over verified HTTPS, which also proves
   * the certificate. The op owns the vhost lifecycle end-state: with a
   * domain it reloads Caddy on the (pre-written) site file; without one it
   * removes any stale vhost, so clearing a domain converges on redeploy.
   * On failure the previous containers keep serving (compose semantics) and
   * the last log lines land on stderr for the deployment record.
   */
  'deploy-stack': `#!/usr/bin/env bash
set -euo pipefail
unit="\${1:?usage: deploy-stack <unit> <dir> <port> [domain]}"
dir="\${2:?usage: deploy-stack <unit> <dir> <port> [domain]}"
port="\${3:?usage: deploy-stack <unit> <dir> <port> [domain]}"
domain="\${4:-}"
{
  [[ "$unit" =~ ^[a-z][a-z0-9_]{0,47}$ ]] || { echo "invalid unit name" >&2; exit 1; }
  [[ "$port" =~ ^[0-9]{2,5}$ ]] || { echo "invalid port" >&2; exit 1; }
  [ -z "$domain" ] || [[ "$domain" =~ ^[a-z0-9.-]+$ ]] || { echo "invalid domain" >&2; exit 1; }
  cd "$dir"
  if ! docker compose -p "$unit" up -d --wait --wait-timeout 300; then
    echo "deploy-stack: unhealthy — diagnostics follow" >&2
    docker compose -p "$unit" ps >&2 || true
    docker compose -p "$unit" logs --tail 40 api >&2 || true
    exit 1
  fi
  # The proxy's service definition rarely changes, so compose keeps the old
  # container — but its mounted nginx.conf may have; force a fresh read.
  docker compose -p "$unit" restart proxy >/dev/null 2>&1 || true
  if [ -n "$domain" ]; then
    if ! docker exec specbook-caddy caddy reload --config /etc/caddy/Caddyfile >&2; then
      echo "deploy-stack: caddy reload failed" >&2
      exit 1
    fi
    # Verified TLS on purpose: a pass proves routing AND a valid certificate.
    # Generous attempts — the first deploy of a hostname waits on issuance.
    for _ in $(seq 1 40); do
      if python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('https://$domain/health', timeout=10).status==200 else 1)" 2>/dev/null; then
        echo "deploy-stack: healthy on https://$domain"
        exit 0
      fi
      sleep 3
    done
    echo "deploy-stack: https://$domain never answered /health (certificate or routing)" >&2
    docker logs --tail 40 specbook-caddy >&2 || true
    exit 1
  fi
  # No domain: drop any vhost a previous configuration left behind.
  if [ -f "$HOME/specbook-caddy/sites/$unit.caddy" ]; then
    rm -f "$HOME/specbook-caddy/sites/$unit.caddy"
    docker exec specbook-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 10); do
    if python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:$port/health', timeout=5).status==200 else 1)" 2>/dev/null; then
      echo "deploy-stack: healthy on :$port"
      exit 0
    fi
    sleep 3
  done
  echo "deploy-stack: proxy on :$port never answered /health" >&2
  docker compose -p "$unit" logs --tail 40 proxy >&2 || true
  exit 1
}
`,

  /** v1: stream one image as a tarball to stdout (binary; used by pipeOp). */
  'image-export': `#!/usr/bin/env bash
set -euo pipefail
image="\${1:?usage: image-export <image>}"
docker save "$image"
`,

  /** v1: load an image tarball from stdin (binary; used by pipeOp). */
  'image-import': `#!/usr/bin/env bash
set -euo pipefail
docker load
`,

  /**
   * v1: tear down one environment's unit — redis container, database, role.
   * Best-effort by design: a half-dead box must not block deletion, so every
   * step tolerates absence.
   */
  'data-plane-deprovision-unit': `#!/usr/bin/env bash
set -uo pipefail
unit="\${1:?usage: data-plane-deprovision-unit <unit>}"
{
  [[ "$unit" =~ ^[a-z][a-z0-9_]{0,47}$ ]] || { echo "invalid unit name" >&2; exit 1; }
  # A deployed stack goes first (containers found by compose project label).
  docker ps -aq --filter "label=com.docker.compose.project=$unit" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker rm -f "specbook-redis-$unit" >/dev/null 2>&1 || true
  # The environment's vhost goes with it; other environments keep serving.
  if [ -f "$HOME/specbook-caddy/sites/$unit.caddy" ]; then
    rm -f "$HOME/specbook-caddy/sites/$unit.caddy"
    docker exec specbook-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
  fi
  if docker exec specbook-postgres true >/dev/null 2>&1; then
    docker exec specbook-postgres psql -U specbook -tA -c \\
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$unit'" >/dev/null 2>&1 || true
    docker exec specbook-postgres psql -U specbook -tA -c "DROP DATABASE IF EXISTS \\"$unit\\"" >/dev/null 2>&1 || true
    docker exec specbook-postgres psql -U specbook -tA -c "DROP ROLE IF EXISTS \\"$unit\\"" >/dev/null 2>&1 || true
  fi
  echo "deprovision-unit: ok"
  exit 0
}
`,
} as const;

export type RemoteOp = keyof typeof REMOTE_OPS;
