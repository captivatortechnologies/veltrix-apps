import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ServerSpec {
  sectionName: string
  /** The server name — its logical identity (list + match). */
  name: string
  description?: string
  /** The server's resolvable domain name (FQDN) or IP address. */
  address: string
  enabled: boolean
}

/** Shape of a server returned by GET /server. */
export interface LiveServer {
  id?: string
  name?: string
  description?: string
  address?: string
  enabled?: boolean
}

/** Read a boolean field, defaulting to `fallback` when unset/non-boolean. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Each canvas item describes one ZPA server. */
export function extractServerSpecs(canvas: CanvasSnapshot): ServerSpec[] {
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
      address: typeof fields.address === 'string' ? fields.address.trim() : '',
      enabled: readBool(fields.enabled, true),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate server configurations: a name and an address are required, and the
 * name is unique across the canvas (matched case-insensitively — ZPA rejects
 * servers differing only in case).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractServerSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Server name is required', code: 'required' })
      continue
    }
    if (spec.name.length > 255) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Server name must be 255 characters or fewer',
        code: 'max_length',
      })
    }
    if (!spec.address) {
      errors.push({
        field: `${prefix}.address`,
        message: `Server "${spec.name}" requires an address (a resolvable FQDN or IP)`,
        code: 'required',
      })
    }
    const key = spec.name.toLowerCase()
    if (seen.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate server "${spec.name}" — each name may only be declared once per canvas`,
        code: 'duplicate_server',
      })
    }
    seen.add(key)
  }

  return { valid: errors.length === 0, errors, warnings }
}
