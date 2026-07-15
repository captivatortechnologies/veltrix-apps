import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

export const VALUE_TYPES = ['boolean', 'string', 'number'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface PolicySettingSpec {
  sectionName: string
  /** Dot-path into the policy object, e.g. "agentUi.agentUiOn". */
  key: string
  valueType: string
  rawValue: string
}

/** Coerce a raw string value into the declared type. */
export function coerceValue(raw: string, valueType: string): unknown {
  if (valueType === 'boolean') return raw.trim().toLowerCase() === 'true'
  if (valueType === 'number') {
    const n = Number(raw.trim())
    return Number.isFinite(n) ? n : raw
  }
  return raw
}

/** Set a dot-path key on a (deep-cloned) object, creating intermediate objects. */
export function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (typeof cursor[part] !== 'object' || cursor[part] === null || Array.isArray(cursor[part])) {
      cursor[part] = {}
    }
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]] = value
}

/** Read a dot-path key from an object; undefined when any segment is absent. */
export function getNestedPath(obj: Record<string, unknown> | undefined, path: string): unknown {
  let cursor: unknown = obj
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/** Each canvas item describes one policy setting to enforce. */
export function extractPolicySettingSpecs(canvas: CanvasSnapshot): PolicySettingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      key: typeof fields.setting_key === 'string' ? fields.setting_key.trim() : '',
      valueType: typeof fields.value_type === 'string' && fields.value_type.trim() ? fields.value_type.trim() : 'boolean',
      rawValue: typeof fields.value === 'string' ? fields.value : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate agent policy setting configurations: a setting key and value are
 * required, the value type is supported, a numeric value parses, and each setting
 * key is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySettingSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.key) {
      errors.push({ field: `${prefix}.setting_key`, message: 'Setting key is required', code: 'required' })
    } else if (seen.has(spec.key)) {
      errors.push({
        field: `${prefix}.setting_key`,
        message: `Duplicate setting key "${spec.key}" — each key may only be declared once`,
        code: 'duplicate_setting',
      })
    }
    seen.add(spec.key)

    if (!VALUE_TYPES.includes(spec.valueType as (typeof VALUE_TYPES)[number])) {
      errors.push({ field: `${prefix}.value_type`, message: `Unsupported value type "${spec.valueType}"`, code: 'invalid_value_type' })
    }
    if (spec.rawValue.trim() === '') {
      errors.push({ field: `${prefix}.value`, message: 'Value is required', code: 'required' })
    } else if (spec.valueType === 'number' && !Number.isFinite(Number(spec.rawValue.trim()))) {
      errors.push({ field: `${prefix}.value`, message: `Value "${spec.rawValue}" is not a number`, code: 'invalid_number' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
