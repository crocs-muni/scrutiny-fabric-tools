# Deploying the scrutiny-fabric relay on Stratus (FI MUNI OpenNebula)

This directory contains the production deployment for the pilot relay:

| File | Role |
| --- | --- |
| `Dockerfile` | Multi-stage build; static `relay` binary on distroless. Build context is the **relay module root** (`relay/`). |
| `compose.yaml` | Relay + Caddy stack. Only Caddy publishes ports; data lives in one named volume. |
| `Caddyfile` | Caddy vhost: TLS (Let's Encrypt) + reverse proxy to `relay:3334`. |
| `../.dockerignore` | Keeps the build context small (`relay/` root). |

---

## 1. Provision the VM (request from CVT)

Send a **production request to `unix@fi.muni.cz`** and ask for:

1. **A persistent VM** on the Stratus OpenNebula cloud (persistent storage, not a
   sandbox/ephemeral instance — the relay's bbolt store and bleve index must
   survive reboots).
2. **A hostname** (`<HOSTNAME>.fi.muni.cz`) with a DNS record pointing at the VM.
   You must supply this exact hostname in the request, and then use it
   identically in the Caddyfile vhost and `SCRUTINY_SERVICE_URL` (see §2).
3. **Ports 80 and 443 open to the internet.** Caddy needs both: 443 serves the
   relay, and 80/443 are used for the ACME challenge that issues the TLS
   certificate. No other inbound port is required.
4. **Docker + the Compose plugin** installed on the VM (Docker Engine ≥ 24 with
   the `docker compose` v2 subcommand). If the image does not ship it, install
   from Docker's official repository:

   ```sh
   # Debian/Ubuntu guest, per https://docs.docker.com/engine/install/
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
   sudo chmod a+r /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
     https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
     | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
   sudo apt-get update
   sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   sudo usermod -aG docker "$USER"   # log out/in to take effect
   ```

Clone the `scrutiny-fabric-tools` repository onto the VM and `cd` into
`relay/deploy/` for every command below.

---

## 2. The hostname must match — three places, one string (NIP-42)

The relay advertises `SCRUTINY_SERVICE_URL` as its **NIP-42 challenge relay tag**
and verifies client signatures against it. Clients sign the URL they connected
to. Therefore these three values **MUST carry the same hostname, byte-for-byte**:

1. the vhost in `deploy/Caddyfile` (`<HOSTNAME>.fi.muni.cz`)
2. `SCRUTINY_SERVICE_URL` in `deploy/compose.yaml` (`wss://<HOSTNAME>.fi.muni.cz`)
3. the DNS record from the CVT request

A mismatch (wrong label, `http` vs `wss`, trailing slash, `www` prefix) makes
every **authenticated publish fail** with an auth error while **reads keep
working** — a quiet, easy-to-miss failure. Change all three together.

---

## 3. First run

1. **Edit `compose.yaml`** and fill the placeholders:
   - `SCRUTINY_SERVICE_URL`: `wss://<HOSTNAME>.fi.muni.cz` (must match §2)
   - `SCRUTINY_ALLOWED_PUBKEYS`: comma-separated publisher pubkeys (64 hex chars
     or `npub1...`). At least one is required; only these may write.
2. **Edit `Caddyfile`** and replace `<HOSTNAME>` with the same host label.
3. **Start the stack** from `deploy/`:

   ```sh
   docker compose up -d --build
   ```

4. **Verify**: watch Caddy obtain its certificate and the relay come up.

   ```sh
   docker compose logs -f caddy   # expect "certificate obtained successfully"
   docker compose logs -f relay   # expect "relay <version> listening on 0.0.0.0:3334"
   ```

5. **Check from the outside** (needs DNS to be live): a Nostr client pointed at
   `wss://<HOSTNAME>.fi.muni.cz` should read events, and an allowlisted publisher
   should be able to publish. The operator endpoints must **not** be public:
   `curl -i https://<HOSTNAME>.fi.muni.cz/healthz` should return `404`, not `200`.
   Reach the real `/healthz` and `/metrics` inside the docker network (§7).

### Configuration environment

All configuration is environment variables read by `internal/config`; only
`SCRUTINY_SERVICE_URL` and `SCRUTINY_ALLOWED_PUBKEYS` are required. The
authoritative table of variables, defaults and meanings is the
[`Environment` section of the relay module README](../README.md#environment)
— a single source of truth, not duplicated here. `compose.yaml` sets the two
required variables; everything else comes from the image or the compiled
defaults.

---

## 4. Logs

Both services log to stdout/stderr; Docker captures them.

```sh
docker compose logs -f relay     # relay logs ([scrutiny-relay] ...)
docker compose logs -f caddy     # Caddy/TLS/ACME logs
docker compose logs -f           # both
```

`docker compose logs` is the only log sink — there are no log files inside the
container (the image is distroless and has no writable filesystem).

---

## 5. Backup — stop, tar, start

The relay data (bbolt `base.bolt` + the `search/` bleve index) lives in the
named volume `scrutiny-relay-data`. **bbolt holds an exclusive file lock while
the relay runs**, so copying the volume under a live relay can capture a torn
database. Stop the relay before archiving:

```sh
cd deploy

# 1. Stop the relay (releases the bbolt lock). Caddy stays up and will 502
#    until the relay returns.
docker compose stop relay

# 2. Archive the volume. (Replace the tag with a digest pin in a real registry setup.)
docker run --rm \
  -v scrutiny-relay-data:/data \
  -v "$PWD":/backup \
  alpine:3.21 tar -czf /backup/relay-data-$(date +%F).tar.gz -C /data .

# 3. Start the relay again.
docker compose start relay
```

Restore is the mirror image (`docker compose stop relay`, untar into the volume,
`docker compose start relay`). Keep backups off the VM.

### Data volume ownership

The image pre-creates `/data` owned by the distroless nonroot uid **65532**, so a
fresh **named volume** (`scrutiny-relay-data`) inherits that ownership and the
relay can write `base.bolt` and `search/` without running as root. If you switch
`relay-data` to a **host bind mount** instead, the host directory is used as-is
and is typically root-owned: `chown 65532:65532` it before the first start, or
the relay will fail to open its store.

---

## 6. Reindex (rebuild the bleve search index)

`relay reindex` wipes the bleve index and replays the bbolt base store into it.
It **opens the bbolt file exclusively**, so it must run against a **stopped**
relay — otherwise it fails on the lock (or, worse, corrupts state if the lock is
bypassed). It only needs `SCRUTINY_DATA_DIR`, which the image already sets.

```sh
cd deploy

# 1. Stop the relay so nothing holds the bbolt lock.
docker compose stop relay

# 2. Run the reindex subcommand in a one-off container on the same volume.
docker compose run --rm relay reindex

# 3. Start the relay again.
docker compose start relay
```

---

## 7. Health and metrics (internal network only)

`/healthz` and `/metrics` are served by the relay on its own port (`3334`), but
they are **never exposed to the internet**: the relay publishes no host ports,
and the public Caddy vhost answers `404` for both paths. They are reachable only
over the internal `scrutiny-relay` Docker network — deliberately, so the metrics
surface is not internet-facing.

The runtime image is distroless (no shell, no `curl`), so `docker exec` into the
relay will not work. Use the Caddy sidecar, which is on the same network:

```sh
docker compose exec caddy wget -qO- http://relay:3334/healthz
docker compose exec caddy wget -qO- http://relay:3334/metrics
```

Alternatively, a throwaway container on the same network:

```sh
docker run --rm --network scrutiny-relay curlimages/curl -s http://relay:3334/healthz
```

Only if an operator has a specific need should they add a `ports:` entry for the
relay in `compose.yaml` (e.g. `127.0.0.1:3334:3334`, loopback-bound). Publishing
`3334` on `0.0.0.0` is **not recommended**: it exposes the metrics/health surface
and bypasses Caddy's TLS.

---

## Operations cheat-sheet

```sh
docker compose up -d --build      # build + (re)start, from deploy/
docker compose ps                 # status
docker compose logs -f relay      # relay logs
docker compose stop relay         # before backup or reindex
docker compose run --rm relay reindex
docker compose start relay
docker compose pull && docker compose up -d   # refresh caddy / rebuild
```
