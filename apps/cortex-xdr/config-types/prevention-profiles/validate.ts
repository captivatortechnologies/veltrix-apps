import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidModulesJson } from './_shared'

/**
 * Validate prevention-profile items: a non-empty name/profile_type/platform,
 * and valid JSON for the required modules object. Static — no target access
 * required. The name doubles as the profile's identity, so a duplicate is
 * flagged (last one wins). `profile_type` / `platform` are not restricted to an
 * enum — Cortex's own docs describe them only as untyped strings (see
 * _shared.ts) — but an unrecognized value is warned on.
 */
const SUSPECTED_PROFILE_TYPES = new Set(['exploit', 'malware', 'restrictions', 'agent_settings', 'exceptions'])
const SUSPECTED_PLATFORMS = new Set(['windows', 'mac', 'linux', 'android', 'ios', 'caas_linux', 'serverless'])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one prevention profile.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const profileType = String(item.fields.profile_type ?? '').trim().toLowerCase()
    const platform = String(item.fields.platform ?? '').trim().toLowerCase()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Profile "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!profileType) {
      errors.push({ field: `items[${i}].profile_type`, message: 'Profile type is required.', code: 'EMPTY_PROFILE_TYPE' })
    } else if (!SUSPECTED_PROFILE_TYPES.has(profileType)) {
      warnings.push({ field: `items[${i}].profile_type`, message: `"${profileType}" is not one of the commonly-seen profile types (${[...SUSPECTED_PROFILE_TYPES].join(', ')}) — VERIFY against your Cortex XDR tenant.`, code: 'UNRECOGNIZED_PROFILE_TYPE' })
    }

    if (!platform) {
      errors.push({ field: `items[${i}].platform`, message: 'Platform is required.', code: 'EMPTY_PLATFORM' })
    } else if (!SUSPECTED_PLATFORMS.has(platform)) {
      warnings.push({ field: `items[${i}].platform`, message: `"${platform}" is not one of the commonly-seen platforms (${[...SUSPECTED_PLATFORMS].join(', ')}) — VERIFY against your Cortex XDR tenant.`, code: 'UNRECOGNIZED_PLATFORM' })
    }

    if (!isValidModulesJson(item.fields.modules)) {
      errors.push({ field: `items[${i}].modules`, message: 'Modules is required and must be a valid JSON object.', code: 'INVALID_MODULES_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
