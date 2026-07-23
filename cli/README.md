# @veltrixsecops/cli

The Veltrix CLI (`veltrix`) — build, validate, package, and live-develop [Veltrix Security-as-Code apps](https://github.com/captivatortechnologies/veltrix-apps) against a sandbox in your own tenant, from your local workspace and any editor.

```bash
npm install -g @veltrixsecops/cli
```

## Commands

### `veltrix init <app-id>`

Scaffolds a new app with the **canonical Veltrix app layout** (pulled fresh from the community repo's `_template/`) and rewrites its identity to your app id:

```bash
veltrix init crowdstrike-edr
cd crowdstrike-edr && npm install
```

### `veltrix validate [dir]`

Validates an app directory against the platform contract — the **same rules CI enforces** on pull requests: manifest schema, handler completeness, no executables, size cap, import boundaries.

```bash
veltrix validate ./crowdstrike-edr
```

### `veltrix package [dir] [--out dist]`

Builds a **release-identical ZIP**: stages the app, compiles server-side TypeScript to CommonJS (hosted platforms run compiled code), and prints the SHA-256. Useful for install-by-URL testing and verifying what CI will ship.

### `veltrix login`

Authenticates against your Veltrix tenant with an API key (create one in **Settings → Keys & Tokens**). The key is verified against the platform and stored in `~/.veltrix/config.json` (mode 600). `VELTRIX_API_KEY` / `VELTRIX_URL` environment variables override the stored profile (useful for CI).

```bash
veltrix login --url https://app.veltrixsecops.com
veltrix whoami
veltrix logout
```

> A browser-based device-code login (no manual key handling) is planned.

## Sandbox development

Sandboxes let you run your work-in-progress app inside your own tenant on the hosted platform: edit locally in any editor, and `veltrix dev` syncs changes near-realtime into the sandbox, where the platform validates and hot-reloads them.

> Requires a tenant with sandboxes enabled (`SANDBOX_ENABLED`) and an API key carrying the `sandbox:read` / `sandbox:write` scopes (Settings → Keys & Tokens). Sandboxes are quota'd per tenant, capped in size, and expire after an idle TTL — every sync renews it.

### `veltrix sandbox create|list|delete|run`

```bash
veltrix sandbox create crowdstrike-dev --app crowdstrike-edr   # one sandbox per app-under-development
veltrix sandbox list                                           # name, app, status, files, size, last sync, expiry
veltrix sandbox delete crowdstrike-dev                         # confirms first; --yes to skip
veltrix sandbox run crowdstrike-dev detections validate       # one-shot handler run in the sandbox
```

### `veltrix dev [dir] --sandbox <name>` — the two-way dev loop

```bash
veltrix dev ./crowdstrike-edr --sandbox crowdstrike-dev --create
```

`veltrix dev` keeps your local workspace and the sandbox in sync **both ways**:

- **Push (local → sandbox).** On startup the app is validated locally (same rules as CI), the sandbox is resolved (`--create` makes it on the fly), and a full sync runs. Then the directory is watched: every save is validated locally, hashed, diffed against the server's manifest (sha256), and only changed files are uploaded as a tar.gz delta — deletes and renames propagate automatically.
- **Pull (sandbox → local).** Edits made in the portal's in-browser sandbox editor are applied to your local files in near-real time, marked `↓ <path> (from sandbox)`. Reverse sync is **on by default**; pass `--no-pull` for the classic one-way watcher.

A typical session:

```
$ veltrix dev ./crowdstrike-edr --sandbox crowdstrike-dev --run detections:validate
veltrix dev
  app:     /home/dev/crowdstrike-edr
  sandbox: crowdstrike-dev @ https://app.veltrixsecops.com
  sync:    ↑ local → sandbox, ↓ sandbox → local
Performing initial sync…
✔ ↑ 42 files in 910ms — server validation passed, 12 transpiled
✔ run detections:validate succeeded in 38ms
Watching for changes… (Ctrl+C to stop)
10:32:04 ✔ ↑ 1 file in 240ms — server validation passed, 12 transpiled
  ↓ config-types/detections/validate.ts (from sandbox)
10:33:17 ✔ ↑ 2 files, ✕ 1 deleted in 310ms — server validation passed
```

Flags:

- `--create` — create the sandbox first if it doesn't exist
- `--run <configTypeId>:<handler>` — invoke a pipeline handler after each successful sync and pretty-print the result + captured logs (on platforms without the sandbox runner yet, the CLI says so and keeps syncing)
- `--logs` — stream live sandbox events over WebSocket when the platform supports it (falls back to sync-response output otherwise)
- `--no-pull` — disable reverse sync; run the classic one-way (local → sandbox) watcher
- `--force-pull` — on conflict, overwrite the local file with the sandbox version instead of skipping
- `--profile <name>` — use a non-default login profile

Local validation failures never interrupt the loop — errors print and the watcher waits for your next save. Connection drops and server-state mismatches recover with an automatic full resync.

#### Reverse sync, conflicts, and echoes

Both the portal editor and the CLI write to the same sandbox, which is the source of truth. Each writer stamps its edits with a per-process id, so neither re-applies its own change (a second guard ignores any change whose content already matches what you last wrote).

When a portal edit arrives, the CLI applies it **only if your local file still matches the sandbox's previous content** — i.e. you have no unsaved changes to that file. Otherwise it prints a conflict and leaves your file untouched:

```
  ⚠ conflict: config-types/detections/validate.ts (local modified — skipped; --force-pull to overwrite)
```

Rerun with `--force-pull` (or edit the file to resolve it) to take the sandbox version. Files are written atomically (temp file + rename), so a partial write is never observed. If the CLI is offline when a portal edit lands, it reconciles on reconnect by hash-diffing the sandbox file list against your workspace and pulling the non-conflicting changes.

> Reverse sync requires a platform with sandbox **live-edit** support (the realtime `sandbox:file-changed` events and the file read API). On older platforms the CLI prints `live pull unavailable — sync remains one-way` once and the push loop keeps working unchanged.

### `.veltrixignore`

`node_modules/`, `.git/`, `dist/` and `.veltrix*` files are never synced. Add a `.veltrixignore` at the app root for anything else, using gitignore-style lines:

```gitignore
# scratch files
*.local.md
fixtures/**/*.bin
build/
!keep.this
```

## Inspecting your tenant

Read-only commands to discover what a deploy needs — which apps and config types exist, which environments, and the configs already in your tenant. All use your API key.

```bash
veltrix apps                 # installed + enabled apps (valid `app` values), with versions
veltrix env                  # environments (valid `environment` names + Tag ids)
veltrix config list          # configuration canvases: id, name, app, type, status, version
veltrix config get <id>      # one canvas with its sections/fields
```

```
$ veltrix config list
ID                                    NAME             APP                TYPE     STATUS    VER
522bc2c7-…                            API Test Group   okta-identity      groups   DRAFT     1
41e1cb12-…                            Test Group1      okta-identity      groups   DEPLOYED  31
```

## Deploying configuration

`veltrix deploy` creates a Configuration Canvas and pushes it to a tool through the platform pipeline — authenticated with your API key. **Approval is always required:** a new canvas is created as a draft and submitted for approval; the pipeline refuses to deploy anything not yet approved, so the CLI never self-approves. A human approves in the portal (or via their own session), then the deploy proceeds.

> Requires an API key whose role holds `configuration-canvas:write` (Settings → Keys & Tokens), and the target tool set up in your tenant (installed app + a Connection + a registered server/component).

### `veltrix deploy <spec.yaml> [--wait]`

The spec (YAML or JSON) describes what to deploy:

```yaml
name: "Okta API Test Group"
app: okta-identity          # the app slug (canvas toolType)
configType: groups          # the config type id (entityType)
environment: LocalBabong    # environment name OR its Tag id
approvers:                  # who must approve — emails or user ids
  - lead@example.com
sections:                   # the canvas content for this config type
  - name: Group
    fields:
      - { key: name, label: Name, fieldType: text, value: "Veltrix API Test Group" }
      - { key: description, label: Description, fieldType: text, value: "Created via veltrix deploy" }
```

```bash
veltrix deploy okta-groups.deploy.yaml
# ✔ Canvas created — <id>
# ✔ Validated
# ✔ Submitted for approval (1 approver)
# ⏳ Awaiting approval. Once approved, deploy with:
#    veltrix deploy --canvas <id> --env LocalBabong
```

Add `--wait` to poll until a human approves, then deploy and stream the deployment to completion in one shot:

```bash
veltrix deploy okta-groups.deploy.yaml --wait
```

Deploy an already-approved canvas (the second half of the two-step flow):

```bash
veltrix deploy --canvas <id> --env LocalBabong
```

Flags: `--wait` (poll for approval, then deploy + follow), `--strategy <DIRECT|CANARY|BLUE_GREEN|ROLLING>`, `--timeout <seconds>` (default 600), `--yes` (skip the pre-deploy confirmation), `--profile <name>`. Environment and approvers may be given as names/emails (resolved for you) or as ids directly.

### `veltrix deploy status <deploymentId>`

Print a deployment's current status and recent logs.

## License

Apache-2.0
