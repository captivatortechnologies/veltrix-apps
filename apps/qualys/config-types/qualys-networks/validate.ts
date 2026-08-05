import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface NetworkSpec {
  sectionName: string
  name: string
}

/** Shape of a custom network parsed from an `action=list` `<NETWORK>` block. */
export interface LiveNetwork {
  id: string
  name: string
}

/** The name natural key — a custom network's logical identity. */
export function networkKey(spec: { name: string }): string {
  return spec.name.trim().toLowerCase()
}

/** Each canvas item describes one Qualys custom network. */
export function extractNetworkSpecs(canvas: CanvasSnapshot): NetworkSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom network configurations: a friendly name is required and
 * unique. Qualys' Networks feature (Network Support) must be enabled for the
 * subscription for these calls to succeed — Qualys itself returns a clear error
 * otherwise, surfaced at deploy time.
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
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Network name is required', code: 'required' })
    }

    if (spec.name) {
      const key = networkKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate network "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_network',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
