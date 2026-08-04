import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Illumio Core Label Group constraints -------------------------------------
// name: 1-255 chars (Terraform `nameValidation` — universal across PCE
// resources: illumio-core/utils.go `StringLenBetween(1, 255)`). key: 1-64
// chars, immutable (ForceNew) — "Key in key-value pair OF CONTAINED LABELS",
// per the Terraform schema's own field description, which is why this
// validator also checks every contained label ref shares the group's key.
// Confirmed against:
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/illumio-core/resource_illumio_label_group.go
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/models/label_group.go

export const MAX_NAME_LENGTH = 255
export const MAX_KEY_LENGTH = 64

export interface LabelRef {
  key: string
  value: string
}

export interface LabelGroupSpec {
  itemId?: string
  name: string
  description: string
  key: string
  labels: LabelRef[]
  externalDataSet: string
  externalDataReference: string
  /** Set when labelsJson failed to parse — the raw parse error, surfaced by validate. */
  labelsError?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function parseLabelRefArray(raw: unknown): { value: LabelRef[]; error?: string } {
  const s = asString(raw)
  if (!s) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch (e) {
    return { value: [], error: `is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { value: [], error: 'must be a JSON array' }
  const value: LabelRef[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    value.push({ key: asString(e.key), value: asString(e.value) })
  }
  return { value }
}

export function extractLabelGroupSpecs(canvas: CanvasSnapshot): LabelGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const parsed = parseLabelRefArray(f.labelsJson)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      key: asString(f.key),
      labels: parsed.value,
      externalDataSet: asString(f.externalDataSet),
      externalDataReference: asString(f.externalDataReference),
      labelsError: parsed.error,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractLabelGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate label group "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.key) {
      errors.push({ field: `${prefix}.key`, message: 'Key is required', code: 'required' })
    } else if (spec.key.length > MAX_KEY_LENGTH) {
      errors.push({ field: `${prefix}.key`, message: `Key must be ${MAX_KEY_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (spec.labelsError) {
      errors.push({ field: `${prefix}.labelsJson`, message: `Labels ${spec.labelsError}`, code: 'invalid_json' })
      return
    }
    spec.labels.forEach((l, li) => {
      if (!l.key || !l.value) {
        errors.push({ field: `${prefix}.labelsJson[${li}]`, message: 'Each label ref needs both key and value', code: 'invalid_label_ref' })
      } else if (spec.key && l.key !== spec.key) {
        errors.push({
          field: `${prefix}.labelsJson[${li}]`,
          message: `Label key "${l.key}" does not match the group's key "${spec.key}" — a label group only contains labels of its own key`,
          code: 'label_key_mismatch',
        })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
