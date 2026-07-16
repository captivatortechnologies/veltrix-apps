import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface PoolSpec {
  sectionName: string
  name: string
  /** Member scan-engine names, one per textarea line (order preserved, blanks dropped). */
  engines: string[]
}

/** Shape of a scan engine pool returned by GET /scan_engine_pools. */
export interface LivePool {
  id?: number
  name?: string
  /** Member engine ids (the API keys pools to engines by id, not name). */
  engines?: number[]
}

/** Shape of a scan engine returned by GET /scan_engines. */
export interface LiveEngine {
  id?: number
  name?: string
}

/** The pool name is the natural key — a pool's logical identity. */
export function poolKey(spec: { name: string }): string {
  return spec.name.trim().toLowerCase()
}

/** Split a newline-delimited textarea into a trimmed, de-blanked list of names. */
export function parseEngineNames(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one InsightVM scan engine pool. */
export function extractPoolSpecs(canvas: CanvasSnapshot): PoolSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      engines: parseEngineNames(typeof fields.engines === 'string' ? fields.engines : ''),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate scan engine pool configurations: a name is required and the pool
 * name (its natural key) is unique across the canvas. Member engines are
 * optional — a pool may be empty — and are validated against the live console
 * (name → id resolution) at deploy time, not here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPoolSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Scan engine pool name is required', code: 'required' })
    }

    if (spec.name) {
      const key = poolKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate scan engine pool "${spec.name}" — each pool name may only be declared once`,
          code: 'duplicate_pool',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
