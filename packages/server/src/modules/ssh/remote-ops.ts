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
} as const;

export type RemoteOp = keyof typeof REMOTE_OPS;
