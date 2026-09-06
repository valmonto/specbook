# OVH staging Postgres

A record of the OVH dedicated server that hosts the staging data plane: what was
built, why it is shaped that way, and the exact recipe an automated provisioner
must run against it. Written from the build itself, not from a plan.

**Status:** the server is finished and verified. specbook cannot drive it yet —
see [What specbook still needs](#what-specbook-still-needs).

## The host

```
rustfs-prod — OVH dedicated, public IP 198.244.200.168
KVM/QEMU + libvirt, default NAT network 192.168.122.0/24

├── staging-db      192.168.122.11    4 GB / 500 GB    PostgreSQL 18
├── build           192.168.122.12    8 GB / 500 GB
└── staging-apps    192.168.122.13    8 GB / 100 GB
```

Guests are Ubuntu 24.04 cloud images brought up with `virt-install --import`
against per-VM cloud-init seed ISOs. Each has a `deploy` user in the `docker`
group, Docker 29.1.3, and a `clean-install` libvirt snapshot taken once the base
image was good.

Addresses are pinned rather than left to DHCP luck:

```bash
virsh net-update default add ip-dhcp-host \
  "<host mac='$mac' name='staging-db' ip='192.168.122.11'/>" --live --config
```

### Reaching the guests

SSH is DNAT'd per VM on the host; only port 22 is forwarded.

| VM | External | Internal |
|---|---|---|
| staging-db | `198.244.200.168:2201` | `192.168.122.11:22` |
| build | `198.244.200.168:2202` | `192.168.122.12:22` |
| staging-apps | `198.244.200.168:2203` | `192.168.122.13:22` |

```bash
iptables -t nat -A PREROUTING -p tcp --dport 2201 -j DNAT --to-destination 192.168.122.11:22
iptables -I FORWARD -p tcp -d 192.168.122.11 --dport 22 \
  -m conntrack --ctstate NEW,ESTABLISHED,RELATED -j ACCEPT
netfilter-persistent save
```

`-I FORWARD` (insert, not append) matters — libvirt puts a REJECT at the end of
that chain, so an appended rule never fires.

From the host, `/root/.ssh/config` gives `ssh staging-db`, `ssh build`,
`ssh staging-apps` using `/root/.ssh/vm_admin`.

## PostgreSQL 18 on staging-db

Installed natively from the PGDG apt repository — **not** a container. The
service is `postgresql@18-main`; config lives in `/etc/postgresql/18/main/`.

### Networking

`listen_addresses = '*'` in `postgresql.conf`, then a dedicated DNAT so the
standard port is never exposed publicly:

```
198.244.200.168:35427  →  192.168.122.11:5432
```

Testing that rule from the KVM host using its own public IP does not work and is
not a valid check — locally generated traffic skips `PREROUTING`. Test from an
external machine.

### TLS

A private CA was created on the host; the server certificate carries
`IP:198.244.200.168` as its SAN, because clients connect by IP rather than a DNS
name. `sslmode=verify-full` checks that SAN, so the connection address and the
certificate identity must agree.

```
CA machine        postgres-ca.key   SECRET, never leaves
                  postgres-ca.crt   distributed to clients
staging-db        server.key        SECRET, /etc/postgresql/18/tls/
                  server.crt
client            postgres-ca.crt
```

```
ssl = on
ssl_min_protocol_version = 'TLSv1.2'
ssl_cert_file = '/etc/postgresql/18/tls/server.crt'
ssl_key_file  = '/etc/postgresql/18/tls/server.key'
password_encryption = 'scram-sha-256'
```

### pg_hba.conf

```
hostssl  all  all  0.0.0.0/0  scram-sha-256
```

`hostssl` (not `host`) is load-bearing: with `host`, TLS is merely *available*
and a client that omits it still connects in cleartext.

Verify the running rules rather than trusting the file:

```bash
sudo -u postgres psql -c \
  "SELECT line_number, type, address, auth_method, error FROM pg_hba_file_rules;"
```

`0.0.0.0/0` means anyone on the internet reaches the auth prompt on 35427. Since
the DNAT is ours, the cheaper place to restrict is the `PREROUTING` rule —
narrow it to the source addresses that actually need it.

## The provisioning role

Applications are never given superuser. One dedicated role provisions tenants:

```sql
CREATE ROLE specbook_provisioner LOGIN PASSWORD '<openssl rand -base64 24>'
  CREATEDB CREATEROLE;
ALTER ROLE specbook_provisioner SET createrole_self_grant = 'set, inherit';
```

`CREATEDB` + `CREATEROLE` is sufficient. On PostgreSQL 16+ a `CREATEROLE` role
can only administer roles **it created**, so this account cannot touch
`postgres` or anything it did not make — which is why superuser is unnecessary.

`createrole_self_grant` is required, not optional: without it, `CREATE ROLE`
grants the creator ADMIN but not SET, and `CREATE DATABASE … OWNER x` fails with
`must be able to SET ROLE "x"`.

### One-time hardening (superuser, once)

```sql
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
```

Run on the VM as `postgres`. It is not part of provisioning and never runs
again. Without it any tenant can connect to the maintenance database and list
every role and database on the cluster.

### Per-tenant recipe

The three statements a provisioner runs, remotely, as `specbook_provisioner`
over TLS — no superuser, no SSH:

```sql
CREATE ROLE     <unit> LOGIN PASSWORD '<generated>';
CREATE DATABASE <unit> OWNER <unit>;
SET ROLE <unit>;
REVOKE CONNECT ON DATABASE <unit> FROM PUBLIC;
RESET ROLE;
```

The `SET ROLE` is what lets the revoke happen without superuser — the
provisioner owns the role, so it can become it and revoke as the database owner.
A fresh database is connectable by `PUBLIC` by default, so skipping that revoke
leaves every tenant readable by every other tenant.

Client connection string:

```
postgresql://<unit>:<pw>@198.244.200.168:35427/<unit>?sslmode=verify-full
# with sslrootcert pointing at postgres-ca.crt
```

## Verified

- TLS 1.3 (`TLS_AES_256_GCM_SHA384`) from an external machine through the DNAT
- `specbook_provisioner` creates a role + database remotely, no superuser
- A tenant connects to its own database and is refused elsewhere:
  `FATAL: permission denied for database "postgres"`

## Gotchas hit while building

- **An `hostssl` line pasted into `postgresql.conf`** breaks `psql` itself, not
  just the server: on Debian/Ubuntu `psql` is a wrapper that parses that file to
  find the cluster port, so it dies before connecting. The error names the file
  and line — believe it.
- **`pg_` is a reserved role-name prefix.** `pg_provisioner` is rejected.
- **PostgreSQL 16+ split role membership** into INHERIT / SET / ADMIN; see
  `createrole_self_grant` above.
- **`REVOKE` silently does nothing** when the caller does not own the object —
  it warns (`no privileges could be revoked`) and returns `REVOKE`.

## What specbook still needs

specbook cannot use this server today. Its data-plane ops assume it owns the
database and shells into its own container:

```bash
docker exec specbook-postgres psql -U specbook …
```

Against a natively-installed Postgres that fails, and
`data-plane-ensure-published` would try to `docker run` a second Postgres
alongside this one. Two further blockers:

- `data-plane-ensure-published` binds `-p "$host:5432:5432"` using the server's
  registered SSH host. `198.244.200.168` is not an address the guest holds, so
  the bind fails.
- `assertPlacement` refuses `tls` transport — only `private-network` is
  provisionable, and that means unencrypted.

Closing this needs an **external database server** mode: a server marked
external, carrying its data host/port and the `specbook_provisioner` credential
sealed with `APP_ENCRYPTION_KEY`; a provisioning path that runs the three
statements above over TLS with a Postgres client instead of `docker exec`; the
`tls` transport allowed; and `postgres-ca.crt` delivered to app containers so
`sslmode=verify-full` can resolve.

See [data-plane-placement.md](data-plane-placement.md) for the placement model
this would plug into.
