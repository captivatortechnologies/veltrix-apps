import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractSoftwareAppSpecs, SOFTWARE_APP_DESIRED_STATES } from './_shared'

/**
 * Validate Software App items: a non-empty, unique displayName (the logical
 * identity) and a required App Catalog Installable Id. Static — no target
 * access required; whether the catalog id actually exists in the org's catalog
 * surfaces at deploy time (JumpCloud rejects an unknown reference).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractSoftwareAppSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Software App.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Display Name is required.', code: 'EMPTY_NAME' })
    } else if (spec.displayName.length > 255) {
      errors.push({ field: `${prefix}.displayName`, message: 'Display Name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.displayName.toLowerCase())) {
      errors.push({
        field: `${prefix}.displayName`,
        message: `Duplicate Software App "${spec.displayName}" — each name may only be declared once per canvas.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.displayName.toLowerCase())
    }

    if (!spec.appCatalogInstallableObjectId) {
      errors.push({
        field: `${prefix}.appCatalogInstallableObjectId`,
        message: `"${spec.displayName || 'app'}" requires an App Catalog Installable Id (from GET /api/v2/software/catalog/apps).`,
        code: 'EMPTY_CATALOG_ID',
      })
    }

    if (!(SOFTWARE_APP_DESIRED_STATES as readonly string[]).includes(spec.desiredState)) {
      errors.push({
        field: `${prefix}.desiredState`,
        message: `desiredState must be one of: ${SOFTWARE_APP_DESIRED_STATES.join(', ')}.`,
        code: 'INVALID_STATE',
      })
    }

    if (spec.desiredState === 'Uninstall') {
      warnings.push({
        field: `${prefix}.desiredState`,
        message: `"${spec.displayName || 'app'}" is set to Uninstall — deploying will remove this app from devices it's assigned to.`,
        code: 'WILL_UNINSTALL',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
