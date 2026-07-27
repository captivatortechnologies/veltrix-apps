import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar resource restriction constraints -----------------------------
//
// A resource restriction limits the data window / execution time / record limit
// applied to exactly one target. There is no name — identity is the target. We
// restrict scope to TENANT and ROLE targets (per-end-user targets are excluded).
// The target is declared by name and resolved to its numeric id in deploy.

export const TARGET_TYPES = ['tenant', 'role'] as const

export interface ResourceRestrictionSpec {
  itemId?: string
  targetType: string
  targetName: string
  dataWindow?: number
  executionTime?: number
  recordLimit?: number
}

/** A resource restriction as returned by GET /config/resource_restrictions. */
export interface LiveResourceRestriction {
  id?: string | number
  data_window?: number
  execution_time?: number
  record_limit?: number
  user_id?: number
  tenant_id?: number
  role_id?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return undefined
}

export function targetKey(targetType: string, targetName: string): string {
  return `${targetType.toLowerCase()}:${targetName.toLowerCase()}`
}

export function extractResourceRestrictionSpecs(canvas: CanvasSnapshot): ResourceRestrictionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      targetType: (asString(f.targetType) || 'tenant').toLowerCase(),
      targetName: asString(f.targetName) || item.name,
      dataWindow: asInt(f.dataWindow),
      executionTime: asInt(f.executionTime),
      recordLimit: asInt(f.recordLimit),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractResourceRestrictionSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!(TARGET_TYPES as readonly string[]).includes(spec.targetType)) {
      errors.push({ field: `${prefix}.targetType`, message: `Target type must be one of: ${TARGET_TYPES.join(', ')}`, code: 'invalid_target_type' })
    }
    if (!spec.targetName) {
      errors.push({ field: `${prefix}.targetName`, message: 'Target name is required', code: 'required' })
    } else {
      const key = targetKey(spec.targetType, spec.targetName)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.targetName`, message: `Duplicate restriction for ${spec.targetType} "${spec.targetName}"`, code: 'duplicate_target' })
      }
      seen.add(key)
    }

    for (const [field, val] of [['dataWindow', spec.dataWindow], ['executionTime', spec.executionTime], ['recordLimit', spec.recordLimit]] as const) {
      if (val !== undefined && val < 0) errors.push({ field: `${prefix}.${field}`, message: `${field} must be non-negative`, code: 'out_of_range' })
    }

    if (spec.dataWindow === undefined && spec.executionTime === undefined && spec.recordLimit === undefined) {
      warnings.push({ field: `${prefix}`, message: 'This restriction sets no limits', code: 'empty_restriction' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
