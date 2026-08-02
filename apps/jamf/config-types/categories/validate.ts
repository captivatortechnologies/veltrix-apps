import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface CategorySpec {
  sectionName: string
  name: string
  priority: number
}

/** Shape of a Jamf Pro Category object, as returned by list/create/update (GET/POST/PUT /v1/categories). */
export interface LiveCategory {
  id?: string
  name?: string
  priority?: number
}

/** The category's logical identity: its name (case-insensitive, trimmed). */
export function categoryKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Build a name → live-category map, case-insensitive, first match wins. */
export function indexCategoriesByName(categories: LiveCategory[]): Map<string, LiveCategory> {
  const byName = new Map<string, LiveCategory>()
  for (const category of categories) {
    if (!category.name) continue
    const key = categoryKey(category.name)
    if (!byName.has(key)) byName.set(key, category)
  }
  return byName
}

/** Each canvas item describes one Jamf Pro category. */
export function extractCategorySpecs(canvas: CanvasSnapshot): CategorySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    // Preserve the raw numeric value (including a non-integer) rather than
    // normalizing it here — `validate` below is the single source of truth
    // for rejecting a bad priority, and normalizing it in extraction would
    // silently turn an invalid value into a valid-looking one before the
    // validator ever sees it.
    const rawPriority = fields.priority
    const priority = typeof rawPriority === 'number' && Number.isFinite(rawPriority) ? rawPriority : 0
    return { sectionName: section.name, name: str(fields.name), priority }
  })
}

/** The `Category` request body the create/update endpoints accept for a spec. */
export function buildCategoryBody(spec: CategorySpec): Record<string, unknown> {
  return { name: spec.name, priority: spec.priority }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Jamf Pro category configurations: a name is required and unique
 * across the canvas (case-insensitive), and priority must be a non-negative
 * integer (the `Category` schema requires an int32 `priority`; Jamf Pro's own
 * UI orders Self Service categories by this value).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCategorySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Category name is required', code: 'required' })
    }

    if (!Number.isInteger(spec.priority) || spec.priority < 0) {
      errors.push({
        field: `${prefix}.priority`,
        message: 'Priority must be a non-negative whole number',
        code: 'invalid_priority',
      })
    }

    if (spec.name) {
      const key = categoryKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate category "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_category',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
