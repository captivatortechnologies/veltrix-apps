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

export interface DriftDiff {
  field: string
  expected: unknown
  actual: unknown
  severity: 'info' | 'warning' | 'critical'
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
}

export interface DeployContext extends PipelineContext {
  component: ComponentRef
  credential: CredentialRef | null
  connectivity: ConnectivityRef | null
  connectivityProvider: ConnectivityProviderRef | null
  previousConfig: CanvasSnapshot | null
  strategy: DeploymentStrategy
  canaryPercent?: number
}

export interface RollbackContext extends PipelineContext {
  component: ComponentRef
  credential: CredentialRef | null
  connectivity: ConnectivityRef | null
  connectivityProvider: ConnectivityProviderRef | null
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
