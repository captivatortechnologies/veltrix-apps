import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- PingOne Populations API constraints -------------------------------------
// https://apidocs.pingidentity.com/pingone/platform/v1/api/#populations
//
// GET/POST  /populations                          - list ({ _embedded: { populations: [...] } }) / create
// GET/PUT/DELETE /populations/{id}                 - read / update / delete
// GET/PUT   /populations/{id}/defaultIdentityProvider - a sub-resource; there is
//   NO delete endpoint for it, so it can only ever be set, never unset.

/** A population name is capped at 128 characters. */
export const MAX_POPULATION_NAME_LENGTH = 128

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface PopulationSpec {
  sectionName: string
  /** Population name - the logical identity deploy matches on. */
  name: string
  description?: string
  /** Whether this population should become the environment's default. */
  default: boolean
  preferredLanguage?: string
  alternativeIdentifiers: string[]
  /** Password policy id to assign; blank means "use the environment default". */
  passwordPolicyId?: string
  /** Identity provider id to set as default; blank means "leave unchanged" (set-only, see canvas.yaml). */
  defaultIdentityProviderId?: string
}

/**
 * Shape of a population returned by GET /populations and /populations/{id}.
 * Carries an index signature so server-managed fields not modeled above
 * (environment, createdAt, updatedAt, userCount, _links) remain readable.
 */
export interface LivePopulation {
  id?: string
  name?: string
  description?: string
  default?: boolean
  preferredLanguage?: string
  alternativeIdentifiers?: string[]
  passwordPolicy?: { id?: string }
  environment?: unknown
  createdAt?: string
  updatedAt?: string
  userCount?: number
  _links?: unknown
  [key: string]: unknown
}

/** Split a canvas `tags` value (array) or comma/newline string into trimmed items. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Each canvas item describes one PingOne population. */
export function extractPopulationSpecs(canvas: CanvasSnapshot): PopulationSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      default: fields.default === true,
      preferredLanguage:
        typeof fields.preferredLanguage === 'string' && fields.preferredLanguage.trim()
          ? fields.preferredLanguage.trim()
          : undefined,
      alternativeIdentifiers: splitList(fields.alternativeIdentifiers),
      passwordPolicyId:
        typeof fields.passwordPolicyId === 'string' && fields.passwordPolicyId.trim()
          ? fields.passwordPolicyId.trim()
          : undefined,
      defaultIdentityProviderId:
        typeof fields.defaultIdentityProviderId === 'string' && fields.defaultIdentityProviderId.trim()
          ? fields.defaultIdentityProviderId.trim()
          : undefined,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate population configurations against the PingOne Populations API.
 * Static only - it never contacts PingOne (options for passwordPolicyId /
 * defaultIdentityProviderId are resolved live by the platform's remote-select
 * UI via options.ts, not here):
 *   - name is required, <= 128 chars, and unique within the canvas
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPopulationSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Population name is required', code: 'required' })
      continue
    }

    if (spec.name.length > MAX_POPULATION_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Population name must be ${MAX_POPULATION_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    const key = spec.name.toLowerCase()
    if (seenNames.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate population "${spec.name}" - each population may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    seenNames.add(key)
  }

  return { valid: errors.length === 0, errors, warnings }
}
