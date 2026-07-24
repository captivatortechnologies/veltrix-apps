// ========================================================================
// Pipeline types for app developers
// These define the handler contracts apps must implement.
//
// This file mirrors the platform's pipeline-engine contract
// (server/src/core/pipeline-engine/types.ts). The platform constructs
// every context; apps only consume them.
// ========================================================================

// --- Shared result types ---

export interface ValidationError {
  field: string
  message: string
  code: string
}

export interface ValidationWarning {
  field: string
  message: string
  code: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
}

export interface DeployResult {
  success: boolean
  message: string
  artifacts?: Record<string, unknown>
  rollbackData?: unknown
}

export interface RollbackResult {
  success: boolean
  message: string
}

export interface HealthCheck {
  name: string
  passed: boolean
  message: string
  latencyMs?: number
}

export interface HealthCheckResult {
  healthy: boolean
  score: number
  checks: HealthCheck[]
}

/**
 * Best-effort attribution for a drifting change: WHO changed the target outside
 * Veltrix, and WHEN, resolved from the tool's own audit/system log (e.g. Okta's
 * System Log). All fields optional — a tool without an audit API, or a change we
 * can't correlate, simply omits it.
 */
export interface DriftActor {
  /** Provider-native actor id (Okta user id, etc.). */
  id?: string
  /** Human-facing name of who made the change. */
  name?: string
  /** Actor email / login, when available. */
  email?: string
  /** ISO timestamp the change was actually made (not when Veltrix detected it). */
  at?: string
  /** Provider event type behind the change, e.g. "group.lifecycle.update". */
  eventType?: string
  /** Where the attribution came from, e.g. "okta-system-log". */
  source?: string
}

export interface DriftDiff {
  field: string
  expected: unknown
  actual: unknown
  severity: 'info' | 'warning' | 'critical'
  /** Who made this change + when, when the tool's audit log lets us attribute it. */
  actor?: DriftActor
}

export interface DriftResult {
  hasDrift: boolean
  diffs: DriftDiff[]
}

export interface ComponentConfigStatus {
  componentId: string
  hostname: string
  deployed: boolean
  version?: string
  lastDeployedAt?: string
  healthy?: boolean
  healthScore?: number
}

export interface ConfigStatus {
  deployed: boolean
  version: string
  lastDeployedAt: string
  componentStatuses: ComponentConfigStatus[]
}

// --- Canvas snapshot ---

/**
 * One item declared by a configuration — one object to create in the target
 * tool (an index, an IOC, a host group). `fields` is flat across the item's
 * presentational groups, so a handler reads every field the user filled in
 * regardless of how the canvas laid them out.
 */
export interface CanvasItemSnapshot {
  /** Stable identity for diffs. Always set by the platform; optional so a
   *  handler's own test fixtures need not invent one. */
  id?: string
  name: string
  fields: Record<string, unknown>
}

/** @deprecated Use {@link CanvasItemSnapshot}. A section IS one item. */
export type CanvasSectionSnapshot = CanvasItemSnapshot

export interface CanvasSnapshot {
  id: string
  canvasId: string
  version: number
  name: string
  toolType: string
  entityType: string
  /** The items to create in the target tool. One configuration can declare many. */
  items: CanvasItemSnapshot[]
  /** @deprecated Alias of {@link items}. */
  sections: CanvasSectionSnapshot[]
  snapshot: Record<string, unknown>
}

export type DeploymentStrategy = 'DIRECT' | 'CANARY' | 'BLUE_GREEN' | 'ROLLING'

// --- Reference types (lightweight refs passed to handlers) ---

export interface EnvironmentRef {
  id: string
  name: string
}

export interface UserRef {
  id: string
  email: string
  name: string | null
}

export interface ComponentRef {
  id: string
  hostname: string
  port: string
  type: string[]
  toolId: string
}

export interface CredentialRef {
  id: string
  name: string
  username: string
  password: string
  apiToken: string | null
  certificate: string | null
}

export interface ConnectivityRef {
  id: string
  status: string
  sshCommand: string | null
  httpsUrl: string | null
  tailscaleDeviceIP: string | null
}

/** Provider-aware connectivity passed to handlers when a ConnectivityProvider is configured */
export interface ConnectivityProviderRef {
  id: string
  providerType: string // 'tailscale' | 'ssh' | 'wireguard' | 'cloudflare_tunnel' | etc.
  name: string
  status: string
  config: Record<string, unknown> // Unmasked config for handler use (server-side only)
}

// --- Platform data access ---

/** Summary of a deployment record, returned by PlatformDataApi */
export interface DeploymentSummary {
  id: string
  canvasId: string
  status: string
  healthScore: number | null
  startedAt: string
  completedAt: string | null
  environment: EnvironmentRef
  /**
   * The app-owned rollback/identity data this deployment stored (DeployResult
   * .rollbackData). A deploy handler reads its OWN prior data here — e.g. the
   * external ids it assigned per canvas item — so the next deploy can match
   * existing objects by stable id (supporting rename) instead of by name.
   */
  rollbackData?: unknown
}

/**
 * Tenant-scoped, read-only access to platform data, provided on every
 * handler context as `ctx.platform`. Apps must use this instead of
 * querying the platform database directly — it is the only supported
 * way to read platform records from an app.
 */
export interface PlatformDataApi {
  /** Latest deployment for a canvas, optionally filtered by status (e.g. 'SUCCEEDED'). */
  getLatestDeployment(
    canvasId: string,
    opts?: { status?: string },
  ): Promise<DeploymentSummary | null>
  /** Components for the current customer, optionally filtered by component types. */
  listComponents(filter?: { types?: string[] }): Promise<ComponentRef[]>
}

// --- Identity broker (brokered / consent-onboarded connections) ---

/**
 * App-only token broker, provided on handler contexts as `ctx.identity` for
 * connections onboarded through the platform's consent flow. It lets a handler
 * mint an app-only access token for a customer tenant WITHOUT holding any
 * secret of its own — the platform uses the central multi-tenant connector
 * app's credentials, does the client-credentials exchange against the customer
 * tenant, and caches (~1h).
 *
 * Dual token source (back-compatible): a brokered connection carries no secret,
 * so its handler reads the token via `ctx.identity`; a BYO-secret connection
 * keeps self-minting from `ctx.credential`. Detect brokered by the absence of a
 * credential secret (and the presence of `ctx.identity`).
 */
export interface IdentityBroker {
  getAccessToken(opts: {
    /** Consented customer Entra tenant id. */
    tenantId: string
    /** Token audience, e.g. `https://graph.microsoft.com` (no `/.default`). */
    resource: string
    /** Sovereign cloud override; defaults to the connection's cloud. */
    cloud?: string
  }): Promise<string>
}

// --- Handler contexts ---

export interface PipelineContext {
  appId: string
  customerId: string
  configTypeId: string
  canvas: CanvasSnapshot
  environment: EnvironmentRef
  user: UserRef
  settings: Record<string, unknown>
  platform: PlatformDataApi
  /**
   * App-only token broker for brokered (consent-onboarded) connections.
   * Optional so existing BYO-secret handlers and contexts are unaffected.
   */
  identity?: IdentityBroker
  /**
   * The resolved deploy target + decrypted credential for this config type's
   * environment, when a connection exists. Present on deploy/rollback/etc. (where
   * they are required), and now ALSO provided (best-effort) to `validate` so a
   * validator can do LIVE checks against the target system (e.g. verifying a
   * referenced id exists) — see the okta-identity live group-id validation.
   * Both are optional/null on the base context: validate must still work with no
   * connection (static-only), and a handler must null-check before using them.
   */
  component?: ComponentRef | null
  credential?: CredentialRef | null
}

// --- Options providers (live field options for the config canvas) ---

/** One selectable option returned by an app's options provider. */
export interface OptionItem {
  /** The stored value (e.g. an Okta group id). */
  value: string
  /** The human label shown in the picker (e.g. the group name). */
  label: string
  /** Optional secondary text (e.g. the id, a type, a description). */
  description?: string
}

/**
 * Context for an app "options provider" — the handler that powers a live
 * `remote-multiselect` config field. The platform resolves the connection
 * (decrypted credential + component) for the app/config type's environment and
 * runs the provider in-process, so it can call the target system directly.
 */
export interface OptionsProviderContext {
  appId: string
  customerId: string
  configTypeId: string
  /** Which option set the field asked for — the field's `optionsSource`. */
  source: string
  /** Optional free-text search entered in the field. */
  query?: string
  component: ComponentRef | null
  credential: CredentialRef | null
  settings: Record<string, unknown>
  identity?: IdentityBroker
}

/** An app handler that returns live options for a `remote-multiselect` field. */
export type OptionsProvider = (ctx: OptionsProviderContext) => Promise<OptionItem[]>

/**
 * A file/command placement onto the target host, provided by the PLATFORM (never
 * by the app) and present only when the component is reachable over managed ZTNA
 * (Tailscale SSH) — otherwise `ctx.remote` is undefined and a handler falls back to
 * whatever it can do over the tool's own API.
 *
 * The app passes TYPED INTENTS, not raw shell: the platform builds an allow-listed
 * command server-side, constrains every path under the target's install root, runs
 * it over the tenant's own managed tailnet, and audits it. Used e.g. to place a
 * Splunk app into `etc/manager-apps` and run `apply cluster-bundle`.
 */
export interface RemoteExecutor {
  /** Resolved install base ($SPLUNK_HOME) on the target — build install paths off this. */
  readonly homeDir: string
  /** Extract a gzipped-tar archive (e.g. a .spl) into an allow-listed remote directory. */
  extractArchive(archive: Uint8Array, remoteDir: string): Promise<void>
  /**
   * Write raw bytes (e.g. a .spl package) to an allow-listed staging path on the
   * target — for a REST `apps/local` install by server-local path (splunkd only
   * parses the form-encoded `name=<path>&filename=true` install, not a multipart
   * upload). `remotePath` must be under `<homeDir>/var/run/veltrix`.
   */
  putFile(bytes: Uint8Array, remotePath: string): Promise<void>
  /**
   * SHA-256 every file under an allow-listed install directory (e.g.
   * `<homeDir>/etc/apps/<app>`), returned as `{ path, sha256 }` with paths
   * relative to that directory. For content drift: compare to the hashes of the
   * files a deploy shipped. Read-only.
   */
  hashTree(remoteDir: string): Promise<Array<{ path: string; sha256: string }>>
  /**
   * Read a single file's contents (UTF-8, size-capped) from under an allow-listed
   * install directory — used to show the actual diff when a file's hash drifted.
   * Read-only.
   */
  readFile(remotePath: string): Promise<string>
  /** Run one allow-listed intent (bundle apply / deploy-server reload / probe). */
  run(intent: RemoteIntent): Promise<RemoteResult>
}

/** Allow-listed remote actions. The platform maps each to a fixed, argument-checked command. */
export type RemoteIntent =
  | { action: 'applyClusterBundle' }
  | { action: 'reloadDeployServer' }
  | { action: 'applyShclusterBundle'; targetUri?: string }
  | { action: 'splunkHome' }
  | { action: 'removePath'; path: string }

export interface RemoteResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export interface DeployContext extends PipelineContext {
  component: ComponentRef
  credential: CredentialRef | null
  connectivity: ConnectivityRef | null
  connectivityProvider: ConnectivityProviderRef | null
  /** Platform-provided remote file/command placement — present only for managed-ZTNA targets. */
  remote?: RemoteExecutor
  previousConfig: CanvasSnapshot | null
  strategy: DeploymentStrategy
  canaryPercent?: number
}

export interface RollbackContext extends PipelineContext {
  component: ComponentRef
  credential: CredentialRef | null
  connectivity: ConnectivityRef | null
  connectivityProvider: ConnectivityProviderRef | null
  /** Platform-provided remote placement — present only for managed-ZTNA targets. */
  remote?: RemoteExecutor
  rollbackData: unknown
  targetVersion: CanvasSnapshot
}

export interface HealthCheckContext extends PipelineContext {
  component: ComponentRef
  credential: CredentialRef | null
  connectivity: ConnectivityRef | null
  connectivityProvider: ConnectivityProviderRef | null
}

export interface DriftContext extends PipelineContext {
  component: ComponentRef
  credential: CredentialRef | null
  connectivity: ConnectivityRef | null
  connectivityProvider: ConnectivityProviderRef | null
  deployedConfig: CanvasSnapshot
  /** Platform-provided remote read access — present only for managed-ZTNA targets. */
  remote?: RemoteExecutor
}

// --- Handler type aliases ---

export type ValidateHandler = (ctx: PipelineContext) => Promise<ValidationResult>
export type DeployHandler = (ctx: DeployContext) => Promise<DeployResult>
export type RollbackHandler = (ctx: RollbackContext) => Promise<RollbackResult>
export type HealthCheckHandler = (ctx: HealthCheckContext) => Promise<HealthCheckResult>
export type DriftDetectHandler = (ctx: DriftContext) => Promise<DriftResult>
export type GetStatusHandler = (ctx: PipelineContext) => Promise<ConfigStatus>

// --- Connection test (connection-level, NOT config-scoped) ---

/**
 * Context for `testConnection` — a lightweight, standalone probe that verifies a
 * Connection's endpoint + credential actually work, independent of any config or
 * canvas. The platform decrypts the credential and runs this in-process, so
 * `credential` carries real secrets. `endpoint` is the connection's target
 * (credential endpoint, or the component hostname). Everything else is optional
 * so an app can test with as little as an endpoint + credential.
 */
export interface TestConnectionContext {
  appId: string
  customerId: string
  /** The connection's target endpoint / base URL, e.g. `https://splunk.internal:8089`. */
  endpoint: string | null
  credential: CredentialRef | null
  component: ComponentRef | null
  connectivity: ConnectivityRef | null
  connectivityProvider: ConnectivityProviderRef | null
  settings: Record<string, unknown>
  /**
   * App-only token broker for brokered (consent-onboarded) connections. A
   * brokered connection's `credential` carries no secret, so its test handler
   * mints a token via `ctx.identity.getAccessToken({ tenantId, resource })`
   * instead of the per-credential client-credentials path. Optional and
   * back-compatible: BYO-secret handlers ignore it.
   */
  identity?: IdentityBroker
}

/** Outcome of a connection test. `ok` gates the ✓/✗; `details` are extra lines. */
export interface TestConnectionResult {
  ok: boolean
  message: string
  /** Optional supporting lines (HTTP status, server version, auth result…). */
  details?: string[]
  /** Round-trip latency in milliseconds, when measured. */
  latencyMs?: number
}

export type TestConnectionHandler = (ctx: TestConnectionContext) => Promise<TestConnectionResult>
