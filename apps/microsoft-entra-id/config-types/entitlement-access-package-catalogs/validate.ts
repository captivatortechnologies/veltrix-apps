import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra entitlement-management access-package-catalog constraints ---------

export const MAX_DISPLAY_NAME_LENGTH = 256
export const CATALOG_STATES = new Set(['published', 'unpublished'])

export interface CatalogSpec {
  itemId?: string
  /** displayName — the logical identity live catalogs are matched on. */
  name: string
  description: string
  state: string
  isExternallyVisible: boolean
}

/** An access package catalog as returned by Graph. */
export interface LiveCatalog {
  id?: string
  displayName?: string
  description?: string | null
  state?: string
  isExternallyVisible?: boolean
  /** userManaged (managed here) vs serviceDefault (built-in, protected). */
  catalogType?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** A built-in service-default catalog (e.g. General) must never be modified. */
export function isBuiltInCatalog(live: LiveCatalog): boolean {
  return live.catalogType === 'serviceDefault'
}

export function extractCatalogSpecs(canvas: CanvasSnapshot): CatalogSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      state: asString(f.state) || 'published',
      isExternallyVisible: asBool(f.isExternallyVisible),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractCatalogSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate catalog "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
      if (key === 'general') {
        warnings.push({
          field: `${prefix}.name`,
          message: 'The built-in "General" catalog is service-managed and will not be modified by this app',
          code: 'reserved_catalog',
        })
      }
    }

    if (!CATALOG_STATES.has(spec.state)) {
      errors.push({
        field: `${prefix}.state`,
        message: `State must be one of ${[...CATALOG_STATES].join(', ')}`,
        code: 'invalid_state',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
