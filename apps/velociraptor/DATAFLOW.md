# 🦖 Velociraptor — Request Flows

> How a request is routed through the system — from the moment you act to when it reaches completion. **Auto-generated** from `manifest.yaml` (regenerate via `scripts/dataflow/generate.mjs`).

**App:** `velociraptor` · **Category:** EDR · **Version:** 0.3.0  
**Operations:** Deploy a configuration · Detect drift · Roll back · Test connection  
Talks to **Velociraptor API** · credentials via the Credential Vault (`ctx.resolveConnection`) · reachable over `ctx.remote`.

Every operation authorizes against **RBAC** first; writes pass a **human approval gate** (enforced for production); credentials are **environment-scoped** and resolved per request.

## Lifecycle — how operations connect

Where a config goes from authoring to steady state, and how each request type feeds the next.

```mermaid
flowchart LR
  connect[/"Test connection"/]
  author("Author config")
  authz{{"Permission check"}}
  validate("Validate")
  approve{{"Approval gate"}}
  deploy["Deploy ▶ (write)"]
  live(["Live & monitored"])
  drift["Drift detect ◀ (read)"]
  correct["Correct (re-deploy)"]
  rollback["Roll back"]
  connect -->|"enables"| authz
  author --> authz
  authz -->|"permitted"| validate
  validate -->|"valid"| approve
  approve -->|"approved"| deploy
  deploy -->|"to env · stored"| live
  live -->|"sweep"| drift
  drift -->|"in sync ✓"| live
  drift -->|"drift found"| correct
  correct --> live
  drift -->|"revert"| rollback
  rollback --> live
  classDef state fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a,font-weight:bold;
  classDef act fill:#ecfeff,stroke:#0ea5e9,color:#0c4a6e;
  classDef gate fill:#fffbeb,stroke:#f59e0b,color:#78350f;
  class live state;
  class deploy,drift,correct,rollback act;
  class authz,approve gate;
```

## Environments & promotion

Config is deployed per environment; connections are environment-scoped. Promotion to production passes the approval gate.

```mermaid
flowchart LR
  E0(["dev"])
  E1(["staging"])
  E0 -->|"promote"| E1
  E2(["production"])
  E1 -->|"promote · approval ✋"| E2
```

## Request flows — how each one reaches completion

### Deploy a configuration

*You publish or change a config (e.g. a policy, rule, or exclusion).*  
<sub>Applies to: 4 config types · 3 API families.</sub>

```mermaid
sequenceDiagram
  autonumber
  participant operator as Operator / API
  participant canvas as Config Canvas
  participant pipeline as Pipeline
  participant rbac as Access · RBAC
  participant approval as Approval gate
  participant handler as App handler
  participant vault as Credential Vault
  participant remote as Network / ZTNA
  participant adapter as Adapter
  participant api as Velociraptor API
  operator->>canvas: author config (typed fields)
  canvas->>pipeline: submit for deploy → target environment
  pipeline->>rbac: authorize actor (RBAC)
  Note over rbac: configuration-canvasread · configuration-canvaswrite · componentread · credentialread + artifactswrite
  rbac-->>pipeline: permitted ✓ / denied
  pipeline->>handler: validate(config)
  Note over handler: schema + business rules
  handler-->>pipeline: valid ✓ / errors
  pipeline->>approval: request approval
  Note over approval: required for production · human-in-the-loop
  approval-->>pipeline: approved by a human — AI cannot self-approve
  pipeline->>handler: deploy(config, ctx)
  handler->>vault: resolveConnection (env-scoped connection)
  vault-->>handler: decrypted credential
  handler->>remote: open ctx.remote channel
  handler->>adapter: map canvas → API shape
  adapter->>api: create / update resource (write ▶)
  api-->>adapter: resource id(s)
  adapter-->>handler: applied result
  handler-->>pipeline: status + rollbackData (prior state)
  pipeline-->>canvas: deployed ✓ to the environment — snapshot stored
```

### Detect drift

*A scheduled sweep or on-demand check reconciles live state against the canvas.*  
<sub>Applies to: 4 config types · 3 API families.</sub>

```mermaid
sequenceDiagram
  autonumber
  participant operator as Operator / API
  participant pipeline as Pipeline
  participant rbac as Access · RBAC
  participant handler as App handler
  participant vault as Credential Vault
  participant adapter as Adapter
  participant api as Velociraptor API
  operator->>pipeline: scheduled sweep / on-demand
  pipeline->>rbac: authorize actor (RBAC)
  Note over rbac: componentread + artifactsread
  rbac-->>pipeline: permitted ✓ / denied
  pipeline->>handler: driftDetect(ctx, snapshot)
  handler->>vault: resolveConnection (env-scoped connection)
  vault-->>handler: decrypted credential
  handler->>adapter: fetch live state
  adapter->>api: read resource (read ◀)
  api-->>adapter: live config
  adapter-->>handler: normalized live
  handler->>handler: diff vs snapshot → DriftDiff[] (per-field actor)
  handler-->>pipeline: in-sync ✓ or drift found
  pipeline-->>operator: drift status → Correct / Acknowledge
```

### Roll back

*Revert a config to its previously-deployed state using the stored rollbackData.*  
<sub>Applies to: 4 config types · 3 API families.</sub>

```mermaid
sequenceDiagram
  autonumber
  participant operator as Operator / API
  participant pipeline as Pipeline
  participant rbac as Access · RBAC
  participant approval as Approval gate
  participant handler as App handler
  participant vault as Credential Vault
  participant adapter as Adapter
  participant api as Velociraptor API
  operator->>pipeline: roll back to prior version
  pipeline->>rbac: authorize actor (RBAC)
  Note over rbac: artifactswrite
  rbac-->>pipeline: permitted ✓ / denied
  pipeline->>approval: request approval
  Note over approval: required for production · human-in-the-loop
  approval-->>pipeline: approved by a human — AI cannot self-approve
  pipeline->>handler: rollback(rollbackData, ctx)
  handler->>vault: resolveConnection (env-scoped connection)
  vault-->>handler: decrypted credential
  handler->>adapter: apply prior state
  adapter->>api: restore resource (write ▶)
  api-->>adapter: ok
  adapter-->>handler: restored
  handler-->>pipeline: rolled back ✓
```

### Test connection

*Verify a tenant credential before any deploy or drift can run.*  
<sub>Applies to: precondition for every operation.</sub>

```mermaid
sequenceDiagram
  autonumber
  participant operator as Operator / API
  participant page as Connections
  participant rbac as Access · RBAC
  participant handler as App handler
  participant vault as Credential Vault
  participant api as Velociraptor API
  operator->>page: enter / select credential (per environment)
  page->>rbac: authorize (RBAC)
  Note over rbac: credentialread
  rbac-->>page: permitted ✓
  page->>handler: testConnection(ctx)
  handler->>vault: resolveConnection
  vault-->>handler: credential
  handler->>api: auth probe (token → whoami)
  api-->>handler: 200 / 401
  handler-->>page: connected ✓ / failed
```

---

<sub>Generated by `scripts/dataflow/generate.mjs`. Solid arrow = call ▶ · dashed = return ◀.</sub>
