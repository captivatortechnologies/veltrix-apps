# @veltrixsecops/cli

The Veltrix CLI (`veltrix`) — build, validate, package, and (soon) live-develop [Veltrix Security-as-Code apps](https://github.com/captivatortechnologies/veltrix-apps) from your local workspace.

```bash
npm install -g @veltrixsecops/cli
```

## Commands

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

### Coming next: sandbox development

```bash
veltrix sandbox create crowdstrike-dev --app crowdstrike-edr
veltrix dev ./crowdstrike-edr --sandbox crowdstrike-dev
```

`veltrix dev` will watch your local app directory from any editor and sync changes near-realtime into a **Sandbox** in your tenant on the hosted platform — validation results and handler logs stream back to your terminal. See the [sandbox plan](https://github.com/captivatortechnologies/veltrix-apps) discussions for status.

## License

Apache-2.0
