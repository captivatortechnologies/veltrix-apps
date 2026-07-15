import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Networks API constraints -----------------------------------------

/** A network name is capped at 255 chars. */
export const MAX_NETWORK_NAME_LENGTH = 255

/** assets_ttl_days is optional but, when set, must fall in this inclusive range. */
export const MIN_ASSETS_TTL_DAYS = 14
export const MAX_ASSETS_TTL_DAYS = 365

/**
 * The built-in default network is literally named "Default" and cannot be
 * updated or deleted. Refuse the reserved name (case-insensitively) so a
 * deployment never tries to adopt or mutate it.
 */
export const RESERVED_NETWORK_NAME = 'default'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface NetworkSpec {
  sectionName: string
  /** Network name — the logical identity; the UUID Tenable assigns belongs here. */
  name: string
  description?: string
  /** Asset age-out TTL in days; absent = use the tenant default. */
  assetsTtlDays?: number
}

/** Shape of a network returned by GET /networks and GET /networks/{uuid}. */
export interface LiveNetwork {
  uuid?: string
  name?: string
  description?: string
  assets_ttl_days?: number
  is_default?: boolean
}

/** Coerce a number-field value to a finite number, or undefined when unset. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Each canvas section describes one Tenable network. */
export function extractNetworkSpecs(canvas: CanvasSnapshot): NetworkSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      assetsTtlDays: toNumber(fields.assetsTtlDays),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate network configurations against Networks API constraints:
 * a name is required (<= 255 chars, not the reserved "default"), any asset TTL
 * must be a whole number of days in [14, 365], and the name — a network's
 * logical identity — must be unique within the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractNetworkSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, not the reserved default, unique in canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Network name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NETWORK_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Network name must be ${MAX_NETWORK_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      // The built-in default network (is_default) cannot be managed — reject its
      // reserved name outright so deploy never targets it.
      if (spec.name.toLowerCase() === RESERVED_NETWORK_NAME) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Network name "default" is reserved — the built-in default network cannot be managed as code',
          code: 'reserved_name',
        })
      }
      // The name is the network's logical identity — dedupe on it. Matched
      // exactly (not case-folded) to align with how deploy resolves the live
      // network, so the dedup key equals the create-vs-update match key.
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate network "${spec.name}" — each network name may only be declared once per canvas`,
          code: 'duplicate_network',
        })
      }
      seenNames.add(spec.name)
    }

    // assetsTtlDays — optional; when present it must be a whole number in [14, 365]
    if (
      spec.assetsTtlDays !== undefined &&
      (!Number.isInteger(spec.assetsTtlDays) ||
        spec.assetsTtlDays < MIN_ASSETS_TTL_DAYS ||
        spec.assetsTtlDays > MAX_ASSETS_TTL_DAYS)
    ) {
      errors.push({
        field: `${prefix}.assetsTtlDays`,
        message: `Asset TTL must be a whole number of days from ${MIN_ASSETS_TTL_DAYS} to ${MAX_ASSETS_TTL_DAYS}`,
        code: 'invalid_ttl',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
