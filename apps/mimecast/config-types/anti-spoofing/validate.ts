import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateTargetV1, parseListV1, type PolicyTargetV1 } from '../../lib/policyTargetV1'

// --- Mimecast Anti-Spoofing policy constraints (Policy Management v1) --------

export const OPTIONS = ['no_action', 'apply', 'apply_non_mimecast'] as const
export const FROM_PARTS = ['envelope_from', 'header_from', 'both'] as const

export interface AntiSpoofingSpec {
  itemId?: string
  /** description — the policy identity. */
  description: string
  option: string
  fromPart: string
  fromType: string
  fromValue: string
  toType: string
  toValue: string
  override: boolean
  bidirectional: boolean
  sourceIPs: string[]
  hostnames: string[]
}

/** An anti-spoofing policy as returned by the v1 API. */
export interface LiveAntiSpoofingPolicy {
  id?: string
  description?: string
  option?: string
  fromPart?: string
  from?: PolicyTargetV1
  to?: PolicyTargetV1
  override?: boolean
  bidirectional?: boolean
  sourceIPs?: string[]
  hostnames?: string[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractAntiSpoofingSpecs(canvas: CanvasSnapshot): AntiSpoofingSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      option: (asString(f.option) || 'apply').toLowerCase(),
      fromPart: (asString(f.fromPart) || 'envelope_from').toLowerCase(),
      fromType: (asString(f.fromType) || 'everyone').toLowerCase(),
      fromValue: asString(f.fromValue),
      toType: (asString(f.toType) || 'everyone').toLowerCase(),
      toValue: asString(f.toValue),
      override: asBool(f.override),
      bidirectional: asBool(f.bidirectional),
      sourceIPs: parseListV1(f.sourceIPs),
      hostnames: parseListV1(f.hostnames),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAntiSpoofingSpecs(ctx.canvas)
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
    if (!(FROM_PARTS as readonly string[]).includes(spec.fromPart)) {
      errors.push({ field: `${prefix}.fromPart`, message: `From part must be one of: ${FROM_PARTS.join(', ')}`, code: 'invalid_from_part' })
    }

    validateTargetV1(spec.fromType, spec.fromValue, 'from', prefix, errors)
    validateTargetV1(spec.toType, spec.toValue, 'to', prefix, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}
