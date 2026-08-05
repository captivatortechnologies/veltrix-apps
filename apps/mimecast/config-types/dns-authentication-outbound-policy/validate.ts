import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateTargetV1, type PolicyTargetV1 } from '../../lib/policyTargetV1'

// --- Mimecast DNS Authentication - Outbound policy constraints --------------
// (Policy Management v1)

export const FROM_PARTS = ['envelope_from', 'header_from', 'both'] as const

export interface DnsAuthOutboundPolicySpec {
  itemId?: string
  /** description — the policy identity. */
  description: string
  /** the secure id of the DNS Authentication - Outbound Definition this policy applies. */
  definitionId: string
  fromPart: string
  fromType: string
  fromValue: string
  toType: string
  toValue: string
}

/** A DNS Authentication - Outbound policy as returned by the v1 API. */
export interface LiveDnsAuthOutboundPolicy {
  id?: string
  description?: string
  definitionId?: string
  fromPart?: string
  from?: PolicyTargetV1
  to?: PolicyTargetV1
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractDnsAuthOutboundPolicySpecs(canvas: CanvasSnapshot): DnsAuthOutboundPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      definitionId: asString(f.definitionId),
      fromPart: (asString(f.fromPart) || 'envelope_from').toLowerCase(),
      fromType: (asString(f.fromType) || 'everyone').toLowerCase(),
      fromValue: asString(f.fromValue),
      toType: (asString(f.toType) || 'everyone').toLowerCase(),
      toValue: asString(f.toValue),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDnsAuthOutboundPolicySpecs(ctx.canvas)
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

    if (!spec.definitionId) {
      errors.push({
        field: `${prefix}.definitionId`,
        message: 'DNS Authentication - Outbound Definition ID is required (the definition this policy applies)',
        code: 'required',
      })
    }

    if (!(FROM_PARTS as readonly string[]).includes(spec.fromPart)) {
      errors.push({ field: `${prefix}.fromPart`, message: `From part must be one of: ${FROM_PARTS.join(', ')}`, code: 'invalid_from_part' })
    }

    validateTargetV1(spec.fromType, spec.fromValue, 'from', prefix, errors)
    validateTargetV1(spec.toType, spec.toValue, 'to', prefix, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}
