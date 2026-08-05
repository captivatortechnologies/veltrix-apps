import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar tagged-field constraints --------------------------------------
//
// POST /ariel/taggedfields creates a field (name, type, private_enterprise_number,
// element_id, category_id, is_array, description). POST /ariel/taggedfields/{id}
// updates ONLY category_id + description — name, type, private_enterprise_number,
// element_id and is_array are IMMUTABLE once created. DELETE /ariel/taggedfields/{id}
// removes it. The category is declared by NAME and resolved to category_id in
// deploy (see the Tagged Field Categories configuration type).

export const FIELD_TYPES = [
  'NULL', 'STRUCT', 'Byte', 'Short', 'Integer', 'Long', 'UnsignedByte', 'UnsignedShort',
  'UnsignedInt', 'UnsignedLong', 'BigInteger', 'Double', 'Float', 'Port', 'Host',
  'HostV4V6', 'HostV6', 'MACAddress', 'String', 'ByteArray', 'UnsignedIntHex', 'Boolean', 'Binary',
] as const

export interface TaggedFieldSpec {
  itemId?: string
  /** name — the field's identity. IMMUTABLE after creation. */
  name: string
  /** IMMUTABLE after creation. */
  type: string
  /** IMMUTABLE after creation. */
  privateEnterpriseNumber: number
  /** IMMUTABLE after creation. */
  elementId: number
  /** IMMUTABLE after creation. */
  isArray: boolean
  /** the tagged-field category name, resolved to category_id in deploy. Mutable. */
  categoryName: string
  /** Mutable. */
  description: string
}

/** A tagged field as returned by GET /ariel/taggedfields. */
export interface LiveTaggedField {
  id?: number
  tag?: number
  name?: string
  type?: string
  private_enterprise_number?: number
  element_id?: number
  is_array?: boolean
  category_id?: number
  description?: string
  uuid?: string
  creation_date?: number
  modified_date?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim())
  return undefined
}

export function extractTaggedFieldSpecs(canvas: CanvasSnapshot): TaggedFieldSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: asString(f.type) || 'String',
      privateEnterpriseNumber: asInt(f.privateEnterpriseNumber) ?? 0,
      elementId: asInt(f.elementId) ?? 0,
      isArray: f.isArray === true,
      categoryName: asString(f.categoryName),
      description: asString(f.description),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTaggedFieldSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > 255) {
        errors.push({ field: `${prefix}.name`, message: 'Name must be 255 characters or fewer', code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate tagged field "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(FIELD_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Field type must be one of: ${FIELD_TYPES.join(', ')}`, code: 'invalid_field_type' })
    }

    if (spec.privateEnterpriseNumber < 0) {
      errors.push({ field: `${prefix}.privateEnterpriseNumber`, message: 'Private enterprise number cannot be negative', code: 'out_of_range' })
    }

    if (!spec.categoryName) {
      errors.push({ field: `${prefix}.categoryName`, message: 'Category is required', code: 'required' })
    }

    if (!spec.description) {
      warnings.push({ field: `${prefix}.description`, message: 'This tagged field has no description', code: 'empty_description' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
