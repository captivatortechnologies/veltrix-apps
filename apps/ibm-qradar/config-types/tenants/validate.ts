import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar tenant constraints -------------------------------------------

export interface TenantSpec {
  itemId?: string
  /** name — the tenant's natural identity (matched by name, rename-safe by id). */
  name: string
  description: string
  eventRateLimit?: number
  flowRateLimit?: number
}

/** A tenant as returned by GET /config/access/tenant_management/tenants. */
export interface LiveTenant {
  id?: number
  name?: string
  description?: string
  event_rate_limit?: number
  flow_rate_limit?: number
  deleted?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return undefined
}

export function extractTenantSpecs(canvas: CanvasSnapshot): TenantSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      eventRateLimit: asInt(f.eventRateLimit),
      flowRateLimit: asInt(f.flowRateLimit),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTenantSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate tenant "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.eventRateLimit !== undefined && spec.eventRateLimit < 0) {
      errors.push({ field: `${prefix}.eventRateLimit`, message: 'Event rate limit must be non-negative', code: 'out_of_range' })
    }
    if (spec.flowRateLimit !== undefined && spec.flowRateLimit < 0) {
      errors.push({ field: `${prefix}.flowRateLimit`, message: 'Flow rate limit must be non-negative', code: 'out_of_range' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
