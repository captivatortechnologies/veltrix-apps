import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud enterprise settings (singleton) ----------------------------
// A per-tenant singleton reconciled by GET-merge-PUT: only the fields the user
// explicitly sets are overlaid onto the current settings. Boolean fields use a
// tri-state (unchanged / enable / disable) so a blank leaves the live value be.
// Global blast radius (session timeout, key validity) — change deliberately.

export interface EnterpriseSettingsSpec {
  itemId?: string
  sessionTimeout?: number
  accessKeyMaxValidity?: number
  notificationThresholdAccessKeysExpiry?: number
  userAttributionInNotification?: boolean
  requireAlertDismissalNote?: boolean
  applyDefaultPoliciesEnabled?: boolean
  alarmEnabled?: boolean
  namedUsersAccessKeysExpiryNotificationsEnabled?: boolean
  defaultPoliciesEnabled?: Record<string, unknown>
  defaultPoliciesError?: string
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

/** Tri-state: '' / undefined -> undefined (unchanged); 'true' -> true; 'false' -> false. */
function toTriState(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  return undefined
}

export function parseDefaultPolicies(v: unknown): { value?: Record<string, unknown>; error?: string } {
  if (isObject(v)) return { value: v }
  if (v === null || v === undefined) return {}
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return {}
    try {
      const parsed = JSON.parse(t)
      if (isObject(parsed)) return { value: parsed }
      return { error: 'Default policies must be a JSON object of severity -> bool' }
    } catch {
      return { error: 'Default policies must be valid JSON' }
    }
  }
  return { error: 'Default policies must be a JSON object' }
}

export function extractEnterpriseSettingsSpecs(canvas: CanvasSnapshot): EnterpriseSettingsSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const dp = parseDefaultPolicies(f.defaultPoliciesEnabled)
    return {
      itemId: item.id,
      sessionTimeout: toNumber(f.sessionTimeout),
      accessKeyMaxValidity: toNumber(f.accessKeyMaxValidity),
      notificationThresholdAccessKeysExpiry: toNumber(f.notificationThresholdAccessKeysExpiry),
      userAttributionInNotification: toTriState(f.userAttributionInNotification),
      requireAlertDismissalNote: toTriState(f.requireAlertDismissalNote),
      applyDefaultPoliciesEnabled: toTriState(f.applyDefaultPoliciesEnabled),
      alarmEnabled: toTriState(f.alarmEnabled),
      namedUsersAccessKeysExpiryNotificationsEnabled: toTriState(f.namedUsersAccessKeysExpiryNotificationsEnabled),
      defaultPoliciesEnabled: dp.value,
      defaultPoliciesError: dp.error,
    }
  })
}

/** Assemble the overlay of only the fields the user explicitly set. */
export function buildOverlay(spec: EnterpriseSettingsSpec): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  if (spec.sessionTimeout !== undefined) o.sessionTimeout = spec.sessionTimeout
  if (spec.accessKeyMaxValidity !== undefined) o.accessKeyMaxValidity = spec.accessKeyMaxValidity
  if (spec.notificationThresholdAccessKeysExpiry !== undefined) o.notificationThresholdAccessKeysExpiry = spec.notificationThresholdAccessKeysExpiry
  if (spec.userAttributionInNotification !== undefined) o.userAttributionInNotification = spec.userAttributionInNotification
  if (spec.requireAlertDismissalNote !== undefined) o.requireAlertDismissalNote = spec.requireAlertDismissalNote
  if (spec.applyDefaultPoliciesEnabled !== undefined) o.applyDefaultPoliciesEnabled = spec.applyDefaultPoliciesEnabled
  if (spec.alarmEnabled !== undefined) o.alarmEnabled = spec.alarmEnabled
  if (spec.namedUsersAccessKeysExpiryNotificationsEnabled !== undefined) o.namedUsersAccessKeysExpiryNotificationsEnabled = spec.namedUsersAccessKeysExpiryNotificationsEnabled
  if (spec.defaultPoliciesEnabled !== undefined) o.defaultPoliciesEnabled = spec.defaultPoliciesEnabled
  return o
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractEnterpriseSettingsSpecs(ctx.canvas)

  if (specs.length > 1) {
    warnings.push({ field: 'items', message: 'Enterprise settings is a singleton — only the first item is applied', code: 'singleton' })
  }

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    for (const [key, val] of [
      ['sessionTimeout', spec.sessionTimeout],
      ['accessKeyMaxValidity', spec.accessKeyMaxValidity],
      ['notificationThresholdAccessKeysExpiry', spec.notificationThresholdAccessKeysExpiry],
    ] as const) {
      if (val !== undefined && val < 0) {
        errors.push({ field: `${prefix}.${key}`, message: `${key} must be a non-negative number`, code: 'invalid_number' })
      }
    }

    if (spec.defaultPoliciesError) {
      errors.push({ field: `${prefix}.defaultPoliciesEnabled`, message: spec.defaultPoliciesError, code: 'invalid_default_policies' })
    }

    if (Object.keys(buildOverlay(spec)).length === 0 && !spec.defaultPoliciesError) {
      warnings.push({ field: `${prefix}`, message: 'No enterprise settings fields are set — this deploy would be a no-op', code: 'empty' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
