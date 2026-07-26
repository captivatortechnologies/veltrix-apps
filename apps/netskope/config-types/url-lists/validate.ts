import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope URL list constraints -------------------------------------------

export const MAX_NAME_LENGTH = 255
export const URL_LIST_TYPES = ['exact', 'regex'] as const

export interface UrlListSpec {
  itemId?: string
  /** name — the logical identity (Netskope url lists are id-addressed; the app
   *  matches on name and stores the id for rename-safety). */
  name: string
  /** exact | regex — how each entry is interpreted. */
  type: string
  urls: string[]
}

/** A url list as returned by GET /api/v2/policy/urllist. */
export interface LiveUrlList {
  id?: number | string
  name?: string
  data?: { urls?: string[]; type?: string }
  pending?: string
  modify_type?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a textarea/array value into trimmed, non-empty entries. */
export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function extractUrlListSpecs(canvas: CanvasSnapshot): UrlListSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: (asString(f.type) || 'exact').toLowerCase(),
      urls: splitEntries(f.urls),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractUrlListSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

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
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate URL list "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (!(URL_LIST_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Type must be one of: ${URL_LIST_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    if (spec.urls.length === 0) {
      warnings.push({
        field: `${prefix}.urls`,
        message: 'This URL list is empty — it will match nothing',
        code: 'empty_urls',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
