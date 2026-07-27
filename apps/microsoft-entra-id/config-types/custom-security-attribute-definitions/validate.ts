import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra custom-security-attribute-definition constraints ------------------
//
// Definitions cannot be deleted; "removal" is a status change to Deprecated.
// Most fields are immutable after creation (only description, status and
// usePreDefinedValuesOnly are mutable).

export const MAX_NAME_LENGTH = 32
export const ATTRIBUTE_TYPES = new Set(['Boolean', 'Integer', 'String'])
export const ATTRIBUTE_STATUSES = new Set(['Available', 'Deprecated'])
const NAME_RE = /^[A-Za-z0-9_]+$/

export interface AttributeDefinitionSpec {
  itemId?: string
  attributeSet: string
  name: string
  type: string
  status: string
  isCollection: boolean
  isSearchable: boolean
  usePreDefinedValuesOnly: boolean
  description: string
}

/** The Graph resource id is `{attributeSet}_{name}`. */
export function definitionId(spec: { attributeSet: string; name: string }): string {
  return `${spec.attributeSet}_${spec.name}`
}

/** A custom security attribute definition as returned by Graph. */
export interface LiveAttributeDefinition {
  id?: string
  attributeSet?: string
  name?: string
  type?: string
  status?: string
  isCollection?: boolean
  isSearchable?: boolean
  usePreDefinedValuesOnly?: boolean
  description?: string | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractAttributeDefinitionSpecs(canvas: CanvasSnapshot): AttributeDefinitionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      attributeSet: asString(f.attributeSet),
      name: asString(f.name),
      type: asString(f.type) || 'String',
      status: asString(f.status) || 'Available',
      isCollection: asBool(f.isCollection),
      isSearchable: asBool(f.isSearchable),
      usePreDefinedValuesOnly: asBool(f.usePreDefinedValuesOnly),
      description: asString(f.description),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAttributeDefinitionSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.attributeSet) {
      errors.push({ field: `${prefix}.attributeSet`, message: 'Attribute set is required', code: 'required' })
    }

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      if (!NAME_RE.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Name may contain only letters, digits and underscores (no spaces)',
          code: 'invalid_name',
        })
      }
    }

    if (!ATTRIBUTE_TYPES.has(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Type must be one of ${[...ATTRIBUTE_TYPES].join(', ')}`,
        code: 'invalid_type',
      })
    }
    if (!ATTRIBUTE_STATUSES.has(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of ${[...ATTRIBUTE_STATUSES].join(', ')}`,
        code: 'invalid_status',
      })
    }

    if (spec.attributeSet && spec.name) {
      const key = definitionId(spec).toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate attribute "${definitionId(spec)}" — each set+name may only be declared once per canvas`,
          code: 'duplicate_definition',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
