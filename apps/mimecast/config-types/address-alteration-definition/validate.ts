import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Mimecast address alteration definition constraints ----------------------

export const ROUTINGS = ['all', 'inbound', 'outbound'] as const
export const ADDRESS_TYPES = [
  'all',
  'envelope_from',
  'envelope_to',
  'from',
  'reply_to',
  'to_cc_bcc',
  'sender',
] as const

/** local@domain | *@domain | local@* — one "@", non-empty, no whitespace. */
const ADDRESS_RE = /^[^@\s]+@[^@\s]+$/

export interface AddressAlterationDefinitionSpec {
  itemId?: string
  /** optional secure id of the Set (folder) this definition lives in (root when omitted). */
  folderId: string
  /** all | inbound | outbound. */
  routing: string
  /** all | envelope_from | envelope_to | from | reply_to | to_cc_bcc | sender. */
  addressType: string
  originalAddress: string
  newAddress: string
}

/** A definition as returned by get-definition. */
export interface LiveDefinition {
  id?: string
  folderId?: string
  routing?: string
  addressType?: string
  originalAddress?: string
  newAddress?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractAddressAlterationDefinitionSpecs(canvas: CanvasSnapshot): AddressAlterationDefinitionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      folderId: asString(f.folderId),
      routing: (asString(f.routing) || 'all').toLowerCase(),
      addressType: (asString(f.addressType) || 'from').toLowerCase(),
      originalAddress: asString(f.originalAddress),
      newAddress: asString(f.newAddress),
    }
  })
}

/** The natural key of a definition — the full rule tuple (there is no name). */
export function definitionKey(d: {
  folderId: string
  routing: string
  addressType: string
  originalAddress: string
  newAddress: string
}): string {
  return [d.folderId, d.routing, d.addressType, d.originalAddress.toLowerCase(), d.newAddress.toLowerCase()].join('|')
}

/** The natural key of a live definition (mirrors definitionKey). */
export function liveDefinitionKey(d: LiveDefinition): string {
  return definitionKey({
    folderId: d.folderId ?? '',
    routing: (d.routing ?? '').toLowerCase(),
    addressType: (d.addressType ?? '').toLowerCase(),
    originalAddress: d.originalAddress ?? '',
    newAddress: d.newAddress ?? '',
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAddressAlterationDefinitionSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!(ROUTINGS as readonly string[]).includes(spec.routing)) {
      errors.push({ field: `${prefix}.routing`, message: `Routing must be one of: ${ROUTINGS.join(', ')}`, code: 'invalid_routing' })
    }
    if (!(ADDRESS_TYPES as readonly string[]).includes(spec.addressType)) {
      errors.push({ field: `${prefix}.addressType`, message: `Address type must be one of: ${ADDRESS_TYPES.join(', ')}`, code: 'invalid_address_type' })
    }

    for (const side of ['originalAddress', 'newAddress'] as const) {
      const value = spec[side]
      if (!value) {
        errors.push({ field: `${prefix}.${side}`, message: `${side} is required`, code: 'required' })
      } else if (!ADDRESS_RE.test(value)) {
        errors.push({ field: `${prefix}.${side}`, message: `${side} must be local@domain, *@domain or local@*`, code: 'invalid_address' })
      }
    }

    if (spec.originalAddress && spec.newAddress) {
      const key = definitionKey(spec)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.originalAddress`, message: 'Duplicate definition — another item declares the same rule tuple', code: 'duplicate_definition' })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
