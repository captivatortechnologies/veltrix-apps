import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cisco Duo account (global) settings -------------------------------------
//
// Account settings are a per-tenant SINGLETON: GET/POST /admin/v1/settings (v1,
// HMAC-SHA1 form-encoded — the existing signer). Every field is optional; a
// field is only MANAGED when the operator sets a value, so unset fields are left
// untouched. Booleans use a tri-state select ("" leaves unmanaged) and serialize
// to "1"/"0"; numbers serialize as strings — the form-encoded wire format Duo
// expects.

export type SettingFieldType = 'int' | 'string' | 'bool' | 'enum'

export interface SettingFieldDef {
  key: string
  type: SettingFieldType
  options?: readonly string[]
  min?: number
}

/** The curated, cleanly-typed subset of Duo global settings this type manages. */
export const SETTING_FIELDS: readonly SettingFieldDef[] = [
  { key: 'lockout_threshold', type: 'int', min: 0 },
  { key: 'lockout_expire_duration', type: 'int', min: 0 },
  { key: 'inactive_user_expiration', type: 'int', min: 0 },
  { key: 'log_retention_days', type: 'int', min: 0 },
  { key: 'minimum_password_length', type: 'int', min: 1 },
  { key: 'password_requires_upper_alpha', type: 'bool' },
  { key: 'password_requires_lower_alpha', type: 'bool' },
  { key: 'password_requires_numeric', type: 'bool' },
  { key: 'password_requires_special', type: 'bool' },
  { key: 'fraud_email', type: 'string' },
  { key: 'fraud_email_enabled', type: 'bool' },
  { key: 'timezone', type: 'string' },
  { key: 'security_checkup_enabled', type: 'bool' },
  { key: 'helpdesk_bypass', type: 'enum', options: ['allow', 'limit', 'deny'] },
  { key: 'helpdesk_message', type: 'string' },
] as const

const BOOL_VALUES = ['true', 'false']

export interface AccountSettingsSpec {
  sectionName: string
  /** Raw (trimmed) values for the keys the operator set (non-empty only). */
  values: Record<string, string>
}

function rawToString(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return String(v)
  return ''
}

export function extractAccountSettingsSpecs(canvas: CanvasSnapshot): AccountSettingsSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const values: Record<string, string> = {}
    for (const def of SETTING_FIELDS) {
      const s = rawToString(f[def.key])
      if (s !== '') values[def.key] = s
    }
    return { sectionName: item.name, values }
  })
}

/** Serialize a managed value to its form-encoded wire form (bool -> 1/0). */
export function serializeSetting(def: SettingFieldDef, raw: string): string {
  if (def.type === 'bool') return raw === 'true' ? '1' : '0'
  return raw
}

/** Serialize a value read back from GET /admin/v1/settings the same way. */
export function serializeLiveSetting(def: SettingFieldDef, live: unknown): string {
  if (def.type === 'bool') {
    return live === true || live === 1 || live === '1' || live === 'true' ? '1' : '0'
  }
  if (live === undefined || live === null) return ''
  return String(live)
}

/** Build the form params for the managed, set fields. */
export function buildSettingsParams(spec: AccountSettingsSpec): Record<string, string> {
  const params: Record<string, string> = {}
  for (const def of SETTING_FIELDS) {
    const raw = spec.values[def.key]
    if (raw !== undefined) params[def.key] = serializeSetting(def, raw)
  }
  return params
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAccountSettingsSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Account settings configuration is required', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (specs.length > 1) {
    errors.push({ field: 'items', message: 'Account settings are a tenant singleton — declare exactly one configuration', code: 'singleton' })
  }

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    for (const def of SETTING_FIELDS) {
      const raw = spec.values[def.key]
      if (raw === undefined) continue
      if (def.type === 'int') {
        const n = Number(raw)
        const min = def.min ?? 0
        if (!Number.isInteger(n) || n < min) {
          errors.push({ field: `${prefix}.${def.key}`, message: `${def.key} must be an integer >= ${min}`, code: 'invalid_number' })
        }
      } else if (def.type === 'bool') {
        if (!BOOL_VALUES.includes(raw)) {
          errors.push({ field: `${prefix}.${def.key}`, message: `${def.key} must be true or false`, code: 'invalid_bool' })
        }
      } else if (def.type === 'enum') {
        if (!(def.options ?? []).includes(raw)) {
          errors.push({ field: `${prefix}.${def.key}`, message: `${def.key} must be one of: ${(def.options ?? []).join(', ')}`, code: 'invalid_enum' })
        }
      }
    }

    if (Object.keys(spec.values).length === 0) {
      warnings.push({ field: prefix, message: 'No settings declared — deploy will be a no-op', code: 'no_settings' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
