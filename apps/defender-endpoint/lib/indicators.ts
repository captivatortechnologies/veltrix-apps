// =============================================================================
// Shared Defender for Endpoint INDICATOR logic.
//
// All indicator config types (file / network / certificate) share one endpoint
// (/api/indicators) and one body shape — they differ only in which
// indicatorTypes they allow and how the value is validated. This module holds
// the common spec model plus the deploy / rollback / drift / health / status
// logic, so each config type is a thin wrapper that supplies its allowed types
// and a value validator.
//
// Reconciliation is non-destructive: a deploy upserts the indicators it declares
// (POST /api/indicators is an upsert on indicatorValue+indicatorType) and, on
// rollback, deletes the ones it created and restores the ones it updated. It
// never deletes indicators it did not declare — several config types (and other
// tools) may share the tenant's 15,000-indicator pool.
// =============================================================================

import type {
  CanvasSnapshot,
  ComponentConfigStatus,
  ConfigStatus,
  DeployContext,
  DeployResult,
  DriftContext,
  DriftDiff,
  DriftResult,
  HealthCheckContext,
  HealthCheckResult,
  PipelineContext,
  RollbackContext,
  RollbackResult,
  ValidationResult,
} from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage, parseJson, type MdeClient } from './mde'

// Valid action set (verified): Warn is Defender-for-Cloud-Apps only; Alert /
// AlertAndBlock are legacy (removed Jan 2022) — not accepted for authoring.
export const INDICATOR_ACTIONS = ['Allowed', 'Audit', 'Block', 'BlockAndRemediate'] as const
export const INDICATOR_SEVERITIES = ['Informational', 'Low', 'Medium', 'High'] as const

export const FILE_INDICATOR_TYPES = ['FileSha256', 'FileSha1', 'FileMd5'] as const
export const NETWORK_INDICATOR_TYPES = ['IpAddress', 'DomainName', 'Url'] as const
export const CERT_INDICATOR_TYPES = ['CertificateThumbprint'] as const

export interface IndicatorSpec {
  sectionName: string
  indicatorType: string
  indicatorValue: string
  action: string
  severity: string
  title: string
  description: string
  expirationTime: string
  application: string
  recommendedActions: string
  rbacGroupNames: string[]
  generateAlert: boolean
}

/** An indicator as returned by GET /api/indicators. */
export interface LiveIndicator {
  id?: string
  indicatorValue?: string
  indicatorType?: string
  action?: string
  severity?: string
  title?: string
  description?: string
  expirationTime?: string
  application?: string
  recommendedActions?: string
  rbacGroupNames?: string[]
  generateAlert?: boolean
}

/** The (indicatorType, indicatorValue) natural key — an indicator's identity. */
export function indicatorKey(type: string, value: string): string {
  return JSON.stringify([type.toLowerCase(), value.trim().toLowerCase()])
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'true' || t === 'yes' || t === '1') return true
    if (t === 'false' || t === 'no' || t === '0' || t === '') return false
  }
  return fallback
}

/** Read a tags/list field into a trimmed string array (accepts a comma string too). */
function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Each canvas item describes one indicator. Field keys are shared across the three types. */
export function extractIndicatorSpecs(canvas: CanvasSnapshot): IndicatorSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      indicatorType: readString(fields.indicator_type),
      indicatorValue: readString(fields.indicator_value),
      action: readString(fields.action) || 'Block',
      severity: readString(fields.severity) || 'Medium',
      title: readString(fields.title),
      description: readString(fields.description),
      expirationTime: readString(fields.expiration_time),
      application: readString(fields.application),
      recommendedActions: readString(fields.recommended_actions),
      rbacGroupNames: readList(fields.rbac_group_names),
      generateAlert: readBool(fields.generate_alert, false),
    }
  })
}

/** Build the POST /api/indicators body for one spec (case-sensitive keys). */
export function buildIndicatorBody(spec: IndicatorSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    indicatorValue: spec.indicatorValue,
    indicatorType: spec.indicatorType,
    action: spec.action,
    title: spec.title,
    description: spec.description,
    // Audit indicators require an alert to be generated.
    generateAlert: spec.action === 'Audit' ? true : spec.generateAlert,
  }
  if (spec.severity) body.severity = spec.severity
  if (spec.expirationTime) body.expirationTime = spec.expirationTime
  if (spec.application) body.application = spec.application
  if (spec.recommendedActions) body.recommendedActions = spec.recommendedActions
  if (spec.rbacGroupNames.length > 0) body.rbacGroupNames = spec.rbacGroupNames
  return body
}

// --- Validation --------------------------------------------------------------

const HEX = /^[0-9a-fA-F]+$/

export function isHexOfLength(value: string, length: number): boolean {
  return value.length === length && HEX.test(value)
}

/** Validate a file-hash indicator value by its subtype. Returns an error or null. */
export function checkFileHash(type: string, value: string): string | null {
  switch (type) {
    case 'FileSha256':
      return isHexOfLength(value, 64) ? null : 'must be a 64-character hex SHA-256'
    case 'FileSha1':
      return isHexOfLength(value, 40) ? null : 'must be a 40-character hex SHA-1'
    case 'FileMd5':
      return isHexOfLength(value, 32) ? null : 'must be a 32-character hex MD5'
    default:
      return `unsupported file indicator type "${type}"`
  }
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const DOMAIN = /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/

function isIpv4(value: string): boolean {
  const m = IPV4.exec(value)
  if (!m) return false
  return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255)
}

function isIpv6(value: string): boolean {
  // Accept a plausible IPv6 (hex groups + colons, optional ::). Not exhaustive.
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(':') && !value.includes('.')
}

/** Validate a network indicator value by its subtype. Returns an error or null. */
export function checkNetworkValue(type: string, value: string): string | null {
  switch (type) {
    case 'IpAddress':
      if (value.includes('/')) return 'must be a single IP address — CIDR ranges are not supported'
      return isIpv4(value) || isIpv6(value) ? null : 'must be a valid IPv4 or IPv6 address'
    case 'DomainName':
      if (/^https?:\/\//i.test(value) || value.includes('/')) return 'must be a bare domain (no scheme or path)'
      return DOMAIN.test(value) ? null : 'must be a valid domain name'
    case 'Url': {
      let parsed: URL
      try {
        parsed = new URL(value)
      } catch {
        return 'must be a valid URL'
      }
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? null : 'must be an http(s) URL'
    }
    default:
      return `unsupported network indicator type "${type}"`
  }
}

/** Validate a certificate thumbprint (SHA-1, 40 hex). Returns an error or null. */
export function checkCertThumbprint(type: string, value: string): string | null {
  if (type !== 'CertificateThumbprint') return `unsupported certificate indicator type "${type}"`
  return isHexOfLength(value, 40) ? null : 'must be a 40-character hex SHA-1 thumbprint'
}

/**
 * Shared indicator validation: each declared item needs a type from `allowedTypes`,
 * a value that passes `checkValue`, a valid action + severity, a title and a
 * description; Audit actions require generate_alert; and the (type, value) key is
 * unique across the canvas.
 */
export function validateIndicators(
  ctx: PipelineContext,
  allowedTypes: readonly string[],
  checkValue: (type: string, value: string) => string | null,
): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no indicator items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIndicatorSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.indicatorType) {
      errors.push({ field: `${prefix}.indicator_type`, message: 'Indicator type is required', code: 'required' })
    } else if (!allowedTypes.includes(spec.indicatorType)) {
      errors.push({ field: `${prefix}.indicator_type`, message: `Unsupported indicator type "${spec.indicatorType}"`, code: 'invalid_type' })
    }

    if (!spec.indicatorValue) {
      errors.push({ field: `${prefix}.indicator_value`, message: 'Indicator value is required', code: 'required' })
    } else if (spec.indicatorType && allowedTypes.includes(spec.indicatorType)) {
      const valueError = checkValue(spec.indicatorType, spec.indicatorValue)
      if (valueError) errors.push({ field: `${prefix}.indicator_value`, message: `Value ${valueError}`, code: 'invalid_value' })
    }

    if (!spec.title) errors.push({ field: `${prefix}.title`, message: 'Title is required', code: 'required' })
    if (!spec.description) errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })

    if (spec.action && !INDICATOR_ACTIONS.includes(spec.action as (typeof INDICATOR_ACTIONS)[number])) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}"`, code: 'invalid_action' })
    }
    if (spec.severity && !INDICATOR_SEVERITIES.includes(spec.severity as (typeof INDICATOR_SEVERITIES)[number])) {
      errors.push({ field: `${prefix}.severity`, message: `Unsupported severity "${spec.severity}"`, code: 'invalid_severity' })
    }
    if (spec.action === 'Audit' && !spec.generateAlert) {
      errors.push({ field: `${prefix}.generate_alert`, message: 'Generate alert must be enabled when the action is Audit', code: 'audit_requires_alert' })
    }

    if (spec.indicatorType && spec.indicatorValue) {
      const key = indicatorKey(spec.indicatorType, spec.indicatorValue)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.indicator_value`, message: `Duplicate indicator ${spec.indicatorType} "${spec.indicatorValue}"`, code: 'duplicate_indicator' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// --- Deploy / rollback / drift / health / status -----------------------------

export interface IndicatorRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveIndicator
}

/** List all indicators the credential can see; throws on a non-OK response. */
export async function listIndicators(client: MdeClient): Promise<LiveIndicator[]> {
  const res = await client.getAll<LiveIndicator>('/indicators', { $top: 10000 })
  if (!res.ok) {
    throw new Error(`Failed to list indicators: ${mdeErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

export async function deployIndicators(ctx: DeployContext): Promise<DeployResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiHost } = built

  const specs = extractIndicatorSpecs(ctx.canvas).filter((s) => s.indicatorType && s.indicatorValue)
  const rollbackState: IndicatorRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const existing = await listIndicators(client)
    const byKey = new Map(
      existing
        .filter((i) => i.indicatorType && i.indicatorValue)
        .map((i) => [indicatorKey(i.indicatorType as string, i.indicatorValue as string), i]),
    )

    for (const spec of specs) {
      const label = `${spec.indicatorType} ${spec.indicatorValue}`
      const key = indicatorKey(spec.indicatorType, spec.indicatorValue)
      const live = byKey.get(key)

      const res = await client.request('POST', '/indicators', { body: buildIndicatorBody(spec) })
      if (!res.ok) throw new Error(`Failed to submit indicator "${label}": ${mdeErrorMessage(res)}`)

      if (live && live.id != null) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
      } else {
        const created = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ key, label, existed: false, id: created?.id })
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} indicator(s) to ${apiHost}`,
      artifacts: { apiHost, deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Indicator deployment failed after ${deployed.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiHost, deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

export async function rollbackIndicators(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IndicatorRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.request('DELETE', `/indicators/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete indicator "${entry.label}": ${mdeErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('POST', '/indicators', { body: restoreBody(entry.prior) })
        if (!res.ok) throw new Error(`Failed to restore indicator "${entry.label}": ${mdeErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} indicator(s)` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

function restoreBody(prior: LiveIndicator): Record<string, unknown> {
  const body: Record<string, unknown> = {
    indicatorValue: prior.indicatorValue,
    indicatorType: prior.indicatorType,
    action: prior.action,
    title: prior.title,
    description: prior.description,
    generateAlert: prior.generateAlert ?? false,
  }
  if (prior.severity) body.severity = prior.severity
  if (prior.expirationTime) body.expirationTime = prior.expirationTime
  if (prior.recommendedActions) body.recommendedActions = prior.recommendedActions
  if (Array.isArray(prior.rbacGroupNames) && prior.rbacGroupNames.length > 0) body.rbacGroupNames = prior.rbacGroupNames
  return body
}

export async function driftIndicators(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractIndicatorSpecs(ctx.deployedConfig).filter((s) => s.indicatorType && s.indicatorValue)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listIndicators(client)
    const byKey = new Map<string, LiveIndicator>(
      live
        .filter((i) => i.indicatorType && i.indicatorValue)
        .map((i) => [indicatorKey(i.indicatorType as string, i.indicatorValue as string), i]),
    )
    for (const spec of specs) {
      const found = byKey.get(indicatorKey(spec.indicatorType, spec.indicatorValue))
      const label = `${spec.indicatorType} ${spec.indicatorValue}`
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if (spec.action && (found.action ?? '') !== spec.action) {
        diffs.push({ field: `${label}.action`, expected: spec.action, actual: found.action ?? 'not set', severity: 'warning' })
      }
      if (spec.severity && (found.severity ?? '') !== spec.severity) {
        diffs.push({ field: `${label}.severity`, expected: spec.severity, actual: found.severity ?? 'not set', severity: 'info' })
      }
    }
  } catch (error) {
    diffs.push({ field: 'mde', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

export async function healthIndicators(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'mde_credential', passed: false, message: built.error }] }
  }
  const { client, apiHost } = built

  const start = Date.now()
  let live: LiveIndicator[] | null = null
  try {
    live = await listIndicators(client)
    checks.push({ name: 'mde_reachable', passed: true, message: `Defender API reachable at ${apiHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'mde_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const keys = new Set(
      live.filter((i) => i.indicatorType && i.indicatorValue).map((i) => indicatorKey(i.indicatorType as string, i.indicatorValue as string)),
    )
    for (const spec of extractIndicatorSpecs(ctx.canvas).filter((s) => s.indicatorType && s.indicatorValue)) {
      const present = keys.has(indicatorKey(spec.indicatorType, spec.indicatorValue))
      checks.push({
        name: `indicator:${spec.indicatorType} ${spec.indicatorValue}`,
        passed: present,
        message: present ? 'Indicator is present' : 'Indicator is missing',
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

export async function getIndicatorStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx
  const latestDeployment = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latestDeployment) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }
  const components = await platform.listComponents({ types: ['mde-tenant'] })
  const componentStatuses: ComponentConfigStatus[] = components.map((comp) => ({
    componentId: comp.id,
    hostname: comp.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || '',
    healthy: latestDeployment.healthScore != null ? latestDeployment.healthScore >= 80 : undefined,
    healthScore: latestDeployment.healthScore ?? undefined,
  }))
  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || latestDeployment.startedAt,
    componentStatuses,
  }
}
