import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractRuntimePolicySpecs } from '../lib/runtimePolicy'

const MALWARE_ACTIONS = new Set(['alert', 'block'])

/**
 * Validate host-runtime-policy items: a non-empty unique name, at least
 * one application scope, and a known malware action when malware scanning is
 * enabled. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractRuntimePolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one host runtime policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 128) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name must be 128 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else if (seen.has(spec.name)) {
      warnings.push({ field: `items[${i}].name`, message: `Policy name "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(spec.name)
    }

    if (spec.applicationScopes.length === 0) {
      errors.push({ field: `items[${i}].applicationScopes`, message: 'At least one application scope is required.', code: 'EMPTY_SCOPES' })
    }

    if (spec.malwareScanEnabled && !MALWARE_ACTIONS.has(spec.malwareScanAction)) {
      errors.push({
        field: `items[${i}].malwareScanAction`,
        message: `Malware action must be one of ${[...MALWARE_ACTIONS].join(', ')} (got "${spec.malwareScanAction}").`,
        code: 'INVALID_MALWARE_ACTION',
      })
    }

    if (spec.allowedExecutablesEnabled && spec.allowedExecutables.length === 0) {
      warnings.push({
        field: `items[${i}].allowedExecutables`,
        message: 'Executable restriction is enabled but no allowed paths are listed — every executable will be blocked.',
        code: 'EMPTY_ALLOWED_EXECUTABLES',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
