import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateTargetV1, type PolicyTargetV1 } from '../../lib/policyTargetV1'

// --- Mimecast Greylisting policy constraints (Policy Management v1) ----------

export const OPTIONS = ['no_action', 'apply'] as const

export interface GreylistingSpec {
  itemId?: string
  /** description — the policy identity. */
  description: string
  option: string
  fromType: string
  fromValue: string
}

/** A greylisting policy as returned by the v1 API. */
export interface LiveGreylistingPolicy {
  id?: string
  description?: string
  option?: string
  from?: PolicyTargetV1
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractGreylistingSpecs(canvas: CanvasSnapshot): GreylistingSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      option: (asString(f.option) || 'apply').toLowerCase(),
      fromType: (asString(f.fromType) || 'everyone').toLowerCase(),
      fromValue: asString(f.fromValue),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractGreylistingSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required (it is the policy identity)', code: 'required' })
    } else {
      const key = spec.description.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.description`, message: `Duplicate policy "${spec.description}"`, code: 'duplicate_description' })
      }
      seen.add(key)
    }

    if (!(OPTIONS as readonly string[]).includes(spec.option)) {
      errors.push({ field: `${prefix}.option`, message: `Option must be one of: ${OPTIONS.join(', ')}`, code: 'invalid_option' })
    }

    validateTargetV1(spec.fromType, spec.fromValue, 'from', prefix, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}
