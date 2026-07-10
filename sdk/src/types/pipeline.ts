// ========================================================================
// Pipeline types for app developers
// These define the handler contracts apps must implement
// ========================================================================

import type { Component, Credential, Connectivity, Tag, User } from './platform'

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

export interface CanvasSnapshot {
  id: string
  canvasId: string
  version: number
  name: string
  toolType: string
  entityType: string
  sections: Array<{
    name: string
    fields: Record<string, unknown>
  }>
  snapshot: Record<string, unknown>
}

export type DeploymentStrategy = 'DIRECT' | 'CANARY' | 'BLUE_GREEN' | 'ROLLING'

// --- Handler contexts ---

export interface PipelineContext {
  appId: string
  customerId: string
  configTypeId: string
  canvas: CanvasSnapshot
  environment: { id: string; name: string }
  user: { id: string; email: string; name: string | null }
  settings: Record<string, unknown>
}

export interface DeployContext extends PipelineContext {
  component: Pick<Component, 'id' | 'hostname' | 'port' | 'type' | 'toolId'>
  credential: Pick<Credential, 'id' | 'name' | 'username' | 'password' | 'apiToken' | 'certificate'> | null
  connectivity: Pick<Connectivity, 'id' | 'status' | 'sshCommand' | 'httpsUrl' | 'tailscaleDeviceIP'> | null
  previousConfig: CanvasSnapshot | null
  strategy: DeploymentStrategy
  canaryPercent?: number
}

export interface RollbackContext extends PipelineContext {
  component: Pick<Component, 'id' | 'hostname' | 'port' | 'type' | 'toolId'>
  credential: Pick<Credential, 'id' | 'name' | 'username' | 'password' | 'apiToken' | 'certificate'> | null
  connectivity: Pick<Connectivity, 'id' | 'status' | 'sshCommand' | 'httpsUrl' | 'tailscaleDeviceIP'> | null
  rollbackData: unknown
  targetVersion: CanvasSnapshot
}

export interface HealthCheckContext extends PipelineContext {
  component: Pick<Component, 'id' | 'hostname' | 'port' | 'type' | 'toolId'>
  credential: Pick<Credential, 'id' | 'name' | 'username' | 'password' | 'apiToken' | 'certificate'> | null
  connectivity: Pick<Connectivity, 'id' | 'status' | 'sshCommand' | 'httpsUrl' | 'tailscaleDeviceIP'> | null
}

export interface DriftContext extends PipelineContext {
  component: Pick<Component, 'id' | 'hostname' | 'port' | 'type' | 'toolId'>
  credential: Pick<Credential, 'id' | 'name' | 'username' | 'password' | 'apiToken' | 'certificate'> | null
  connectivity: Pick<Connectivity, 'id' | 'status' | 'sshCommand' | 'httpsUrl' | 'tailscaleDeviceIP'> | null
  deployedConfig: CanvasSnapshot
}

// --- Handler type aliases ---

export type ValidateHandler = (ctx: PipelineContext) => Promise<ValidationResult>
export type DeployHandler = (ctx: DeployContext) => Promise<DeployResult>
export type RollbackHandler = (ctx: RollbackContext) => Promise<RollbackResult>
export type HealthCheckHandler = (ctx: HealthCheckContext) => Promise<HealthCheckResult>
export type DriftDetectHandler = (ctx: DriftContext) => Promise<DriftResult>
export type GetStatusHandler = (ctx: PipelineContext) => Promise<ConfigStatus>
