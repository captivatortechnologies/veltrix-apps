import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Mimecast address alteration set constraints -----------------------------

export interface AddressAlterationSetSpec {
  itemId?: string
  /** description — the folder name (the set's logical identity, under parentId). */
  description: string
  /** optional secure id of the parent set (root when omitted). */
  parentId: string
}

/** An address alteration set as returned by get-address-alteration-set. */
export interface LiveSet {
  id?: string
  description?: string
  parentId?: string
  source?: string
  userCount?: number
  folderCount?: number
  folders?: LiveSet[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractAddressAlterationSetSpecs(canvas: CanvasSnapshot): AddressAlterationSetSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      description: asString(f.description) || item.name,
      parentId: asString(f.parentId),
    }
  })
}

/** The identity a set is matched on (folder name, scoped by parent when given). */
export function setKey(spec: { description: string; parentId: string }): string {
  return spec.parentId ? `${spec.description.toLowerCase()}|${spec.parentId}` : spec.description.toLowerCase()
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAddressAlterationSetSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required (it is the set identity)', code: 'required' })
      return
    }

    const key = setKey(spec)
    if (seen.has(key)) {
      errors.push({ field: `${prefix}.description`, message: `Duplicate set "${spec.description}" under the same parent`, code: 'duplicate_description' })
    }
    seen.add(key)
  })

  return { valid: errors.length === 0, errors, warnings }
}
