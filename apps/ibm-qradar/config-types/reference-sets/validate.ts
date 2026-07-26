import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar reference set constraints ------------------------------------

export const ELEMENT_TYPES = ['ALN', 'ALNIC', 'IP', 'NUM', 'PORT', 'DATE'] as const

export interface ReferenceSetSpec {
  itemId?: string
  /** name — the reference set's identity in the classic API. */
  name: string
  /** ALN | ALNIC | IP | NUM | PORT | DATE (immutable after create). */
  elementType: string
  values: string[]
}

/** A reference set as returned by GET /reference_data/sets/{name}. */
export interface LiveReferenceSet {
  name?: string
  element_type?: string
  number_of_elements?: number
  data?: Array<{ value?: string }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a textarea/array into trimmed, non-empty, de-duplicated values. */
export function splitValues(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.map((x) => String(x).trim())
    : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractReferenceSetSpecs(canvas: CanvasSnapshot): ReferenceSetSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      elementType: (asString(f.elementType) || 'ALN').toUpperCase(),
      values: splitValues(f.values),
    }
  })
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isValidIpv4(value: string): boolean {
  const m = IPV4.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractReferenceSetSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate reference set "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(ELEMENT_TYPES as readonly string[]).includes(spec.elementType)) {
      errors.push({ field: `${prefix}.elementType`, message: `Element type must be one of: ${ELEMENT_TYPES.join(', ')}`, code: 'invalid_element_type' })
    }

    // Light value validation for the strongly-typed sets.
    if (spec.elementType === 'IP') {
      spec.values.forEach((v, vi) => {
        if (!isValidIpv4(v)) errors.push({ field: `${prefix}.values[${vi}]`, message: `"${v}" is not a valid IPv4 address`, code: 'invalid_ip' })
      })
    } else if (spec.elementType === 'NUM' || spec.elementType === 'PORT') {
      spec.values.forEach((v, vi) => {
        if (!/^\d+$/.test(v)) errors.push({ field: `${prefix}.values[${vi}]`, message: `"${v}" is not numeric`, code: 'invalid_number' })
      })
    }

    if (spec.values.length === 0) {
      warnings.push({ field: `${prefix}.values`, message: 'This reference set is empty', code: 'empty_set' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
