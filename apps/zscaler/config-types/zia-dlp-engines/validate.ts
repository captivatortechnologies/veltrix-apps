import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA DLP Engines constraints ---------------------------------------------

/** ZIA caps a DLP engine name at 255 characters. */
export const MAX_ENGINE_NAME_LENGTH = 255
/** ZIA allows a longer free-text description on a DLP engine. */
export const MAX_ENGINE_DESCRIPTION_LENGTH = 10_240

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface DlpEngineSpec {
  sectionName: string
  /** The DLP engine name — its logical identity (list + match). */
  name: string
  description?: string
  /** Boolean expression over DLP dictionaries, e.g. "((D63.S > 1))". */
  engineExpression: string
  /** Whether this is a custom (author-managed) engine — always true here. */
  customDlpEngine: boolean
}

/** Shape of a DLP engine returned by GET /dlpEngines. */
export interface LiveDlpEngine {
  id?: number
  name?: string
  description?: string
  engineExpression?: string
  /** false for predefined (built-in) engines, which are read-only. */
  customDlpEngine?: boolean
  /** Present on predefined engines (the built-in engine key). */
  predefinedEngineName?: string
}

/** Coerce a canvas boolean field, falling back when unset (booleans may arrive as strings). */
export function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

/** Each canvas item describes one ZIA DLP engine. */
export function extractDlpEngineSpecs(canvas: CanvasSnapshot): DlpEngineSpec[] {
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
      engineExpression:
        typeof fields.engine_expression === 'string' ? fields.engine_expression.trim() : '',
      // A managed engine is always custom (predefined engines are read-only).
      customDlpEngine: readBoolean(fields.custom_dlp_engine, true),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate DLP engine configurations against ZIA constraints: a name is required,
 * capped at 255 chars, and unique across the canvas (matched case-insensitively,
 * since ZIA rejects engines differing only in case). The engine expression — the
 * boolean rule over DLP dictionaries — is also required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDlpEngineSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'DLP engine name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_ENGINE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `DLP engine name must be ${MAX_ENGINE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate DLP engine "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_dlp_engine',
        })
      }
      seen.add(key)
    }

    if (!spec.engineExpression) {
      errors.push({
        field: `${prefix}.engine_expression`,
        message: 'Engine expression is required — e.g. "((D63.S > 1))"',
        code: 'required',
      })
    }

    if (spec.description && spec.description.length > MAX_ENGINE_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_ENGINE_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
