# Browser Runtime — Launch Foundation

Status: preparation only. No real Kasm session is created in this slice. This
document records the contracts a later slice will build on.

## Model ownership

- `BrowserRuntime` — one prepared browser-play identity per logical Title.
  `manifestId` points at an admin-owned runtime manifest.
- `BrowserSession` — one launch attempt per (user, runtime). Nullable unique
  `activeKey` (`<browserRuntimeId>:<userId>`) blocks duplicate active sessions at
  the database level while allowing ended rows and different users.

## Manifest contract

Location: `MANIFEST_ROOT/<manifestId>.json` (`/srv/vn-runtime/manifests`). The
manifest lives outside the frozen golden so golden contents never mutate.

Example (Kinkoi):

```json
{
  "version": 1,
  "browserRuntimeId": "<uuid>",
  "golden": "Kinkoi Golden Loveriche",
  "runnerImage": "vn-runner-noble:1.19.0",
  "entrypoint": "Kinkoi.exe",
  "workingDir": ".",
  "winePrefix": null,
  "locale": null,
  "env": {},
  "saveStrategy": "whole-tree-cow",
  "validatedAt": "2026-09-26T00:00:00Z"
}
```

Rules enforced by `services/runtimeManifest.js`:

- `golden` is a single directory name beneath `GOLDEN_ROOT` (no separators, no
  `..`, no leading slash).
- `entrypoint`/`workingDir`/`winePrefix` are relative and must resolve inside the
  golden (`resolveWithin` containment check).
- `runnerImage` must be in the allow-list (`KASM_ALLOWED_IMAGES`, default
  `vn-runner-noble:1.19.0`).
- `saveStrategy` must be `whole-tree-cow`.
- `browserRuntimeId`, when present, must match the `BrowserRuntime.id`.

`canLaunch(runtime)` = `state === READY` + manifest reference present + manifest
validates against the real filesystem. READY transition semantics are unchanged
for now.

## Per-user runtime layout

```
/srv/vn-runtime/users/<userId>/<browserRuntimeId>/
    runtime/   persistent writable COW clone of the golden
    scratch/   disposable session scratch
```

`services/runtimeState.js` prepares this with `cp -a --reflink=always`. If the
filesystem cannot reflink, preparation fails (no silent full copy). Clone uses a
temp dir + atomic rename, so a failed clone leaves no half-valid runtime.

## Kasm mount isolation

The VN Runner image uses Kasm variable substitution in `volume_mappings`:

```json
{
  "/srv/vn-runtime/users/{custom_attribute_1}/{custom_attribute_2}/runtime": {
    "bind": "/vn-runtime", "mode": "rw", "uid": 1000, "gid": 1000
  },
  "/srv/vn-runtime/users/{custom_attribute_1}/{custom_attribute_2}/scratch": {
    "bind": "/vn-scratch", "mode": "rw", "uid": 1000, "gid": 1000
  }
}
```

`custom_attribute_1` = application user id, `custom_attribute_2` =
BrowserRuntime id, set on the Kasm user via `/api/update_user_attribute` before
`/api/request_kasm`. A session therefore receives write access only to its own
runtime tree — never other users, `golden/`, or `staging/`.

### Why the target must be per-Kasm-user, not shared

Kasm expands these variables in `ProviderManager.get_container`
(`api_server/provider_manager.py`, ~line 488) via `variable_substitution`
(~line 651), using the `custom_attribute_1/2/3` columns of the **Kasm user**
passed in. The manager guardian loop (`api_server/manager_api_server.py`,
~line 183) calls `get_container` again for any kasm still in
`ASSIGNED`/`REQUESTED`, re-reading the user's **current** attributes. So a single
shared Kasm user is NOT race-safe: a concurrent launch by another app user
overwrites the attributes and the first session can be re-expanded onto the
wrong tree.

The corrected model (`services/runtimeTarget.js`):

1. One dedicated Kasm user per app user, `vnoctis-<appUserId>` (created lazily
   via the Kasm Admin API). `custom_attribute_1` is therefore stable and
   independent per app user.
2. `custom_attribute_2` (runtime id) is the only value set per launch.
3. At most one active `BrowserSession` per app user (`activeKey = userId`), so
   `custom_attribute_2` cannot change while a kasm is still `ASSIGNED`/`REQUESTED`.
   Same-user multi-runtime concurrency is intentionally not supported yet.
4. A per-user application mutex makes `setRuntimeTarget -> requestSession`
   atomic. Callers must use `launchBrowserSession`, never the two calls
   separately.

Different app users have different Kasm identities, so different-user
concurrency is retained.

## Credentials and TLS

- Create a dedicated Kasm Developer API credential: Kasm UI → Admin → API →
  Create API Key. Secret is shown once. Inject as `KASM_API_KEY` /
  `KASM_API_KEY_SECRET`; it is never stored in the DB or sent to the browser.
- `KASM_BASE_URL=https://holo`; compose maps `holo` to the host gateway so the
  name matches the Kasm certificate CN.
- Trust the Kasm cert explicitly instead of disabling TLS verification: copy
  `/opt/kasm/current/certs/kasm_nginx.crt` to `<VNM_ROOT>/data/kasm-ca.crt` and
  set `KASM_CA_PATH=/data/kasm-ca.crt`.

## vnm-api mounts

Golden read-only, manifests writable, users read-write — never the whole
`/srv/vn-runtime` read-write.

## Host Kasm configuration record (Holo) + rollback

These are host-side Kasm DB changes made outside the repo. Recorded here so they
can be reproduced or undone after a reboot/rebuild without `/tmp` backups.

- Kasm version: 1.19.0. Image/workspace `vn-runner-noble:1.19.0`,
  `image_id = caaa88a2-41f0-4ea3-9f86-4d8773d2031b`.
- DB: `kasm_db` container, table `images`, via
  `psql -U kasmapp -h 127.0.0.1 -d kasm`.

### volume_mappings

Prior (unsafe, whole-tree RW):

```json
{"/srv/vn-runtime": {"bind": "/vn-runtime", "mode": "rw", "uid": 1000, "gid": 1000}}
```

Current (per-user, secure):

```json
{
  "/srv/vn-runtime/users/{custom_attribute_1}/{custom_attribute_2}/runtime": {"bind": "/vn-runtime", "mode": "rw", "uid": 1000, "gid": 1000},
  "/srv/vn-runtime/users/{custom_attribute_1}/{custom_attribute_2}/scratch": {"bind": "/vn-scratch", "mode": "rw", "uid": 1000, "gid": 1000}
}
```

### exec_config.first_launch

Prior:

```
bash -c 'chown kasm-user:kasm-user /dev/dri/card0 /dev/dri/renderD128 && mkdir -p /home/kasm-user/.cache && chown -R kasm-user:kasm-user /home/kasm-user/.cache && su - kasm-user -c "xfconf-query -c xfce4-terminal -p /misc-show-unsafe-paste-dialog -s false"'
```

Current (card renumber tolerated):

```
bash -c 'chown kasm-user:kasm-user /dev/dri/card0 /dev/dri/renderD128 2>/dev/null || true; mkdir -p /home/kasm-user/.cache; chown -R kasm-user:kasm-user /home/kasm-user/.cache; su - kasm-user -c "xfconf-query -c xfce4-terminal -p /misc-show-unsafe-paste-dialog -s false"'
```

`run_config` devices are unchanged (`/dev/dri/card0`, `/dev/dri/renderD128`), with
`DRINODE=/dev/dri/renderD128`.

### Rollback / reproduction

Set the column back to the desired JSON value (quote with a dollar-quoted string
to preserve `{custom_attribute_N}` braces), e.g.:

```bash
docker exec kasm_db bash -lc 'PGPASSWORD=$POSTGRES_PASSWORD psql -U kasmapp -h 127.0.0.1 -d kasm -c \
  "UPDATE images SET volume_mappings = \$json\$<JSON>\$json\$ WHERE image_id = '"'"'caaa88a2-41f0-4ea3-9f86-4d8773d2031b'"'"';"'
```

`/tmp/kasm-image-mapping.old` and `/tmp/kasm-image-exec.old` hold the exact
pre-change values for a one-time recovery, but the values above are canonical.

### Kasm identity provisioning

Creating the dedicated per-app-user Kasm users requires an Admin-capable Kasm
credential (`/api/admin/create_user`, `/api/admin/get_users`). The Developer API
key currently used for `/api/request_kasm` must belong to an admin, or a separate
admin credential must be configured. No credential is created by this slice.
