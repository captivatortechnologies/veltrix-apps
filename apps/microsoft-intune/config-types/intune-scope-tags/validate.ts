import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * The reserved name of the Intune built-in "Default" role scope tag (id "0").
 * It is managed by Intune — never created, renamed or deleted here — so declaring
 * it warns and deploy skips any live tag whose name matches it or that is built-in.
 */
export const RESERVED_BUILT_IN_NAME = 'default'

export interface ScopeTagSpec {
  sectionName: string
  name: string
  description: string
}

/** The scope tag name (displayName) is the reconciliation key. */
export function scopeTagKey(name: string): string {
  return name.trim().toLowerCase()
}

/** True when a name is the reserved built-in "Default" tag name (case-insensitive). */
export function isReservedName(name: string): boolean {
  return scopeTagKey(name) === RESERVED_BUILT_IN_NAME
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Each canvas item is one role scope tag: a name + optional description. */
export function extractScopeTagSpecs(canvas: CanvasSnapshot): ScopeTagSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
    }
  })
}

/**
 * Validate role scope tags: each needs a name that is unique across the canvas.
 * A tag named "Default" warns (non-blocking) — that name is reserved for the
 * built-in tag, which is managed by Intune and never modified by a deploy.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no role scope tag items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScopeTagSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Scope tag name is required', code: 'required' })
      continue
    }

    const key = scopeTagKey(spec.name)
    if (seen.has(key)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate scope tag name "${spec.name}"`, code: 'duplicate_scope_tag' })
    }
    seen.add(key)

    if (isReservedName(spec.name)) {
      warnings.push({
        field: `${prefix}.name`,
        message: 'The name "Default" is reserved for the built-in scope tag (id "0"), which is managed by Intune — it will be skipped and never modified',
        code: 'reserved_built_in',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
