import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud alert rule (scan config) constraints -----------------------

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 2000

export interface AlertRuleSpec {
  itemId?: string
  /** name — the identity (Prisma matches alert rules by name). */
  name: string
  description: string
  enabled: boolean
  scanAll: boolean
  policies: string[]
  policyLabels: string[]
  excludedPolicies: string[]
  allowAutoRemediate: boolean
  delayNotificationMs?: number
  notifyOnOpen: boolean
  notifyOnDismissed: boolean
  notifyOnSnoozed: boolean
  notifyOnResolved: boolean
  /** target scope. */
  accountGroups: string[]
  excludedAccounts: string[]
  regions: string[]
  /** target tags — a JSON array of { key, values }. */
  tags: unknown[]
  tagsError?: string
  /** third-party notification channels — a JSON array (alertRuleNotificationConfig). */
  notificationConfig: unknown[]
  notificationConfigError?: string
}

/** An alert rule as returned by GET /v2/alert/rule. */
export interface LiveAlertRule {
  policyScanConfigId?: string
  name?: string
  enabled?: boolean
  scanAll?: boolean
  policies?: string[]
  description?: string | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function splitIds(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function parseJsonArray(v: unknown, label: string): { value: unknown[]; error?: string } {
  if (Array.isArray(v)) return { value: v }
  if (v === null || v === undefined) return { value: [] }
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return { value: [] }
    try {
      const parsed = JSON.parse(t)
      if (Array.isArray(parsed)) return { value: parsed }
      return { value: [], error: `${label} must be a JSON array` }
    } catch {
      return { value: [], error: `${label} must be valid JSON` }
    }
  }
  return { value: [], error: `${label} must be a JSON array` }
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export function extractAlertRuleSpecs(canvas: CanvasSnapshot): AlertRuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const tags = parseJsonArray(f.tags, 'Tags')
    const nc = parseJsonArray(f.notificationConfig, 'Notification config')
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      enabled: f.enabled === undefined ? true : asBool(f.enabled),
      scanAll: f.scanAll === undefined ? true : asBool(f.scanAll),
      policies: splitIds(f.policies),
      policyLabels: splitIds(f.policyLabels),
      excludedPolicies: splitIds(f.excludedPolicies),
      allowAutoRemediate: asBool(f.allowAutoRemediate),
      delayNotificationMs: toNumber(f.delayNotificationMs),
      notifyOnOpen: f.notifyOnOpen === undefined ? true : asBool(f.notifyOnOpen),
      notifyOnDismissed: asBool(f.notifyOnDismissed),
      notifyOnSnoozed: asBool(f.notifyOnSnoozed),
      notifyOnResolved: asBool(f.notifyOnResolved),
      accountGroups: splitIds(f.accountGroups),
      excludedAccounts: splitIds(f.excludedAccounts),
      regions: splitIds(f.regions),
      tags: tags.value,
      tagsError: tags.error,
      notificationConfig: nc.value,
      notificationConfigError: nc.error,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAlertRuleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate alert rule "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (spec.accountGroups.length === 0) {
      errors.push({ field: `${prefix}.accountGroups`, message: 'At least one target account group id is required', code: 'required' })
    }

    if (!spec.scanAll && spec.policies.length === 0 && spec.policyLabels.length === 0) {
      warnings.push({ field: `${prefix}.policies`, message: 'Scan-all is off but no policies or policy labels are selected', code: 'no_policies' })
    }

    if (spec.delayNotificationMs !== undefined && spec.delayNotificationMs < 0) {
      errors.push({ field: `${prefix}.delayNotificationMs`, message: 'Delay must be a non-negative number of milliseconds', code: 'invalid_delay' })
    }

    if (spec.tagsError) {
      errors.push({ field: `${prefix}.tags`, message: spec.tagsError, code: 'invalid_tags' })
    }
    if (spec.notificationConfigError) {
      errors.push({ field: `${prefix}.notificationConfig`, message: spec.notificationConfigError, code: 'invalid_notification_config' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
