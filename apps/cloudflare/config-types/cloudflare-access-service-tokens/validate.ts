import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ServiceTokenSpec {
  sectionName: string
  name: string
  duration?: string
}

/**
 * Shape of a service token returned by GET /access/service_tokens.
 *
 * ⚠ SECURITY: `client_secret` is intentionally NOT part of this interface. It is
 * returned exactly once by the create call and is write-only — it is never read
 * back, listed, diffed or stored anywhere in this config type.
 */
export interface LiveServiceToken {
  id?: string
  name?: string
  /** Non-secret public identifier of the token (safe to read; not the secret). */
  client_id?: string
  duration?: string
}

/** The token's logical identity — its name, folded to a case-insensitive key. */
export function serviceTokenKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item describes one Cloudflare Access service token. */
export function extractServiceTokenSpecs(canvas: CanvasSnapshot): ServiceTokenSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const duration = typeof fields.duration === 'string' ? fields.duration.trim() : ''
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      duration: duration.length > 0 ? duration : undefined,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Access service token configurations: a name is required for each
 * token, and the name (its logical identity) must be unique across the canvas.
 * Duration is optional and free-form (e.g. "8760h" / "forever"), so it is not
 * constrained here. The client secret is write-only and never appears in a
 * canvas, so nothing about it is validated.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractServiceTokenSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Service token name is required', code: 'required' })
    }

    if (spec.name) {
      const key = serviceTokenKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate service token "${spec.name}" — each token name may only be declared once`,
          code: 'duplicate_service_token',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
