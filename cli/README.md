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

### `veltrix dev [dir] --sandbox <name>` — the dev loop

```bash
veltrix dev ./crowdstrike-edr --sandbox crowdstrike-dev --create
```

On startup the app is validated locally (same rules as CI), the sandbox is resolved (`--create` makes it on the fly), and a full sync runs. Then the directory is watched: every save is validated locally, hashed, diffed against the server's manifest (sha256), and only changed files are uploaded as a tar.gz delta — deletes and renames propagate automatically. A typical session:

```
$ veltrix dev ./crowdstrike-edr --sandbox crowdstrike-dev --run detections:validate
veltrix dev
  app:     /home/dev/crowdstrike-edr
  sandbox: crowdstrike-dev @ https://app.veltrixsecops.com
Performing initial sync…
✔ ↑ 42 files in 910ms — server validation passed, 12 transpiled
✔ run detections:validate succeeded in 38ms
Watching for changes… (Ctrl+C to stop)
10:32:04 ✔ ↑ 1 file in 240ms — server validation passed, 12 transpiled
✔ run detections:validate succeeded in 41ms
10:33:17 ✔ ↑ 2 files, ✕ 1 deleted in 310ms — server validation passed
```

Flags:

- `--create` — create the sandbox first if it doesn't exist
- `--run <configTypeId>:<handler>` — invoke a pipeline handler after each successful sync and pretty-print the result + captured logs (on platforms without the sandbox runner yet, the CLI says so and keeps syncing)
- `--logs` — stream live sandbox events over WebSocket when the platform supports it (falls back to sync-response output otherwise)
- `--profile <name>` — use a non-default login profile

Local validation failures never interrupt the loop — errors print and the watcher waits for your next save. Connection drops and server-state mismatches recover with an automatic full resync.

### `.veltrixignore`

`node_modules/`, `.git/`, `dist/` and `.veltrix*` files are never synced. Add a `.veltrixignore` at the app root for anything else, using gitignore-style lines:

```gitignore
# scratch files
*.local.md
fixtures/**/*.bin
build/
!keep.this
```

## License

Apache-2.0
