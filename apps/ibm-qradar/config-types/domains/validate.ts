import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar domain constraints -------------------------------------------

export interface DomainSpec {
  itemId?: string
  /** name — the domain's natural identity (matched by name, rename-safe by id). */
  name: string
  description: string
}

/** A domain as returned by GET /config/domain_management/domains. */
export interface LiveDomain {
  id?: number
  name?: string
  description?: string
  deleted?: boolean
  tenant_id?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractDomainSpecs(canvas: CanvasSnapshot): DomainSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDomainSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate domain "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.description) {
      warnings.push({ field: `${prefix}.description`, message: 'This domain has no description', code: 'empty_description' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
