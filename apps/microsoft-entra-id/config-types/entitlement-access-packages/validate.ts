import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra entitlement-management access-package constraints -----------------
//
// Nested under a catalog (resolved by catalog display name). Resource-role
// scopes are not managed by this type.

export const MAX_DISPLAY_NAME_LENGTH = 256

export interface AccessPackageSpec {
  itemId?: string
  /** displayName — the logical identity live access packages are matched on. */
  name: string
  /** The display name of the catalog this package belongs to (resolved to an id). */
  catalogName: string
  description: string
  isHidden: boolean
}

/** An access package as returned by Graph. */
export interface LiveAccessPackage {
  id?: string
  displayName?: string
  description?: string | null
  isHidden?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractAccessPackageSpecs(canvas: CanvasSnapshot): AccessPackageSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      catalogName: asString(f.catalogName),
      description: asString(f.description),
      isHidden: asBool(f.isHidden),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAccessPackageSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
      errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (!spec.catalogName) {
      errors.push({ field: `${prefix}.catalogName`, message: 'Catalog name is required', code: 'required' })
    }

    if (spec.name && spec.catalogName) {
      const key = `${spec.catalogName.toLowerCase()}|${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate access package "${spec.name}" in catalog "${spec.catalogName}"`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
