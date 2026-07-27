import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope AI Gateway API token group constraints -------------------------

export const MAX_NAME_LENGTH = 100

export interface TokenGroupSpec {
  itemId?: string
  /** name — the logical identity (groups are id-addressed; 1-100 chars). This
   *  manages the token GROUP container, not the per-token secrets. */
  name: string
  description: string
}

/** A token group as returned by GET /api/v2/aig/tokengroups. */
export interface LiveTokenGroup {
  id?: number | string
  group_id?: number | string
  name?: string
  description?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function liveTokenGroupId(l: LiveTokenGroup): string | undefined {
  const v = l.id ?? l.group_id
  return v === undefined || v === null ? undefined : String(v)
}

export function extractTokenGroupSpecs(canvas: CanvasSnapshot): TokenGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    description: asString(item.fields?.description),
  }))
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTokenGroupSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate token group "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
