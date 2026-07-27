import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cisco Duo Passport config constraints -----------------------------------
//
// Passport is a per-tenant SINGLETON: GET/POST /admin/v2/passport/config (V5).
// There is no create/delete — deploy is a GET-then-POST patch.

export const ENABLED_STATUSES = ['disabled', 'enabled', 'enabled-for-groups', 'enabled-with-exceptions'] as const

export interface PassportSpec {
  sectionName: string
  enabledStatus: string
  /** Group ids allowed when status is enabled-for-groups. */
  enabledGroups: string[]
  /** Group ids excepted when status is enabled-with-exceptions. */
  disabledGroups: string[]
  customBrowsersMacos: string[]
  customBrowsersWindows: string[]
}

/** GET /admin/v2/passport/config shape (groups come back as objects). */
export interface LivePassportConfig {
  enabled_status?: string
  enabled_groups?: Array<{ group_id?: string; group_name?: string } | string> | null
  disabled_groups?: Array<{ group_id?: string; group_name?: string } | string> | null
  custom_supported_browsers?: { macos?: string[]; windows?: string[] } | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a textarea (newline- or comma-separated) into a deduped, trimmed list. */
export function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return dedupe(v.map((x) => String(x).trim()).filter(Boolean))
  if (typeof v !== 'string') return []
  return dedupe(
    v
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

/** Normalize live group entries (objects or strings) to id strings. */
export function normalizeGroupIds(list: LivePassportConfig['enabled_groups']): string[] {
  if (!Array.isArray(list)) return []
  return dedupe(
    list
      .map((g) => (typeof g === 'string' ? g : asString(g?.group_id)))
      .filter(Boolean)
  )
}

export function extractPassportSpecs(canvas: CanvasSnapshot): PassportSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      sectionName: item.name,
      enabledStatus: asString(f.enabled_status),
      enabledGroups: parseList(f.enabled_groups),
      disabledGroups: parseList(f.disabled_groups),
      customBrowsersMacos: parseList(f.custom_browsers_macos),
      customBrowsersWindows: parseList(f.custom_browsers_windows),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPassportSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Passport configuration is required', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (specs.length > 1) {
    errors.push({ field: 'items', message: 'Passport config is a tenant singleton — declare exactly one configuration', code: 'singleton' })
  }

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    if (!spec.enabledStatus) {
      errors.push({ field: `${prefix}.enabled_status`, message: 'Enabled status is required', code: 'required' })
    } else if (!(ENABLED_STATUSES as readonly string[]).includes(spec.enabledStatus)) {
      errors.push({
        field: `${prefix}.enabled_status`,
        message: `Enabled status must be one of: ${ENABLED_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    if (spec.enabledStatus === 'enabled-for-groups' && spec.enabledGroups.length === 0) {
      warnings.push({
        field: `${prefix}.enabled_groups`,
        message: 'Status is enabled-for-groups but no enabled group ids were provided — Passport will apply to no one',
        code: 'no_groups',
      })
    }
    if (spec.enabledStatus === 'enabled-with-exceptions' && spec.disabledGroups.length === 0) {
      warnings.push({
        field: `${prefix}.disabled_groups`,
        message: 'Status is enabled-with-exceptions but no disabled group ids were provided — there are no exceptions',
        code: 'no_groups',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
