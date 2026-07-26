import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { slugify } from '../../lib/sentinel'

/** One saved search (hunting query) authored on the canvas. */
export interface SavedSearchSpec {
  sectionName: string
  name: string
  /** URL-safe savedSearchId derived from the name (deterministic → idempotent PUT). */
  savedSearchId: string
  category: string
  query: string
  functionAlias: string
  functionParameters: string
}

/** The reconciliation key is the slug of the display name (also the savedSearchId). */
export function savedSearchKey(name: string): string {
  return slugify(name)
}

/** Each canvas item is one saved search. */
export function extractSavedSearchSpecs(canvas: CanvasSnapshot): SavedSearchSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.saved_search_name === 'string' ? fields.saved_search_name.trim() : ''
    return {
      sectionName: section.name,
      name,
      savedSearchId: slugify(name),
      category: typeof fields.category === 'string' && fields.category.trim() ? fields.category.trim() : 'Hunting Queries',
      query: typeof fields.query === 'string' ? fields.query.trim() : '',
      functionAlias: typeof fields.function_alias === 'string' ? fields.function_alias.trim() : '',
      functionParameters: typeof fields.function_parameters === 'string' ? fields.function_parameters.trim() : '',
    }
  })
}

/**
 * Validate hunting queries / saved searches. Each needs a unique name, a category
 * and a KQL query. Function parameters are only meaningful together with a
 * function alias.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no hunting queries', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const spec of extractSavedSearchSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.saved_search_name`, message: 'Name is required', code: 'required' })
    } else {
      const key = savedSearchKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.saved_search_name`,
          message: `Duplicate name "${spec.name}" (names must be unique after slugging to "${key}")`,
          code: 'duplicate_saved_search',
        })
      }
      seen.add(key)
    }

    if (!spec.category) {
      errors.push({ field: `${prefix}.category`, message: 'Category is required', code: 'required' })
    }

    if (!spec.query) {
      errors.push({ field: `${prefix}.query`, message: 'KQL query is required', code: 'required' })
    }

    if (spec.functionParameters && !spec.functionAlias) {
      errors.push({
        field: `${prefix}.function_parameters`,
        message: 'Function parameters require a function alias',
        code: 'parameters_without_alias',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
