import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Gateway list constraints -------------------------------------

/** The list types Cloudflare Gateway supports. */
export const GATEWAY_LIST_TYPES = ['DOMAIN', 'IP', 'URL', 'EMAIL', 'SERIAL'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface GatewayListSpec {
  sectionName: string
  name: string
  type: string
  description: string
  items: string[]
}

/** Shape of a Gateway list returned by GET /gateway/lists. */
export interface LiveGatewayList {
  id?: string
  name?: string
  type?: string
  description?: string
  /** Cloudflare reports the entry count on the list metadata; items are fetched separately. */
  count?: number
  items?: Array<{ value?: string }>
}

/** Split a textarea value into trimmed, non-empty lines — one list entry per line. */
export function parseItems(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The identity key for a Gateway list — its name, case-folded so re-runs match. */
export function gatewayListKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item describes one Cloudflare Gateway list. */
export function extractGatewayListSpecs(canvas: CanvasSnapshot): GatewayListSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      type: typeof fields.type === 'string' ? fields.type.trim().toUpperCase() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      items: parseItems(fields.items),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Gateway list configurations against Cloudflare constraints: name and
 * type are required, the type must be one Cloudflare supports, and the list name
 * (the reconciliation identity) must be unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractGatewayListSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'List name is required', code: 'required' })
    }
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'List type is required', code: 'required' })
    } else if (!GATEWAY_LIST_TYPES.includes(spec.type as (typeof GATEWAY_LIST_TYPES)[number])) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported list type "${spec.type}"`, code: 'invalid_type' })
    }

    if (spec.name) {
      const key = gatewayListKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate Gateway list "${spec.name}" — each list name may only be declared once`,
          code: 'duplicate_gateway_list',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
