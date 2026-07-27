import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope NPA publisher constraints --------------------------------------

export const MAX_NAME_LENGTH = 64

export interface PublisherSpec {
  itemId?: string
  /** name — the logical identity (publishers are id-addressed; the app matches
   *  on name and stores the publisher_id for rename-safety). */
  name: string
  /** Local broker connect toggle. */
  lbrokerconnect: boolean
}

/** A publisher as returned by GET /api/v2/infrastructure/publishers
 *  (list nested under data.publishers). */
export interface LivePublisher {
  publisher_id?: number | string
  publisher_name?: string
  lbrokerconnect?: boolean
  status?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractPublisherSpecs(canvas: CanvasSnapshot): PublisherSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    lbrokerconnect: item.fields?.lbrokerconnect === true,
  }))
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPublisherSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate publisher "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
