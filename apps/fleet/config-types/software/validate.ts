import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SOURCE_TYPES, PLATFORMS } from './_shared'

/**
 * Validate software items: a known source, a non-empty identifier (numeric for
 * Fleet-maintained apps), a numeric team id, a known platform, self-service
 * required for Android, and a valid auto-update window when auto-update is on.
 * Static — no target access required.
 */
const TEAM_ID_RE = /^[0-9]+$/
const FMA_ID_RE = /^[0-9]+$/
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const YES_NO = new Set(['yes', 'no'])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one software title.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const sourceType = String(item.fields.sourceType ?? 'fleet_maintained').trim()
    const identifier = String(item.fields.identifier ?? '').trim()
    const platform = String(item.fields.platform ?? 'darwin').trim().toLowerCase()
    const teamId = String(item.fields.teamId ?? '').trim()
    const selfService = String(item.fields.selfService ?? 'no').trim().toLowerCase()
    const autoUpdateEnabled = String(item.fields.autoUpdateEnabled ?? 'no').trim().toLowerCase()
    const autoUpdateWindowStart = String(item.fields.autoUpdateWindowStart ?? '').trim()
    const autoUpdateWindowEnd = String(item.fields.autoUpdateWindowEnd ?? '').trim()
    const key = `${sourceType}:${identifier}:${teamId}`

    if (!SOURCE_TYPES.has(sourceType)) {
      errors.push({ field: `items[${i}].sourceType`, message: `Source must be one of fleet_maintained, app_store (got "${sourceType}").`, code: 'INVALID_SOURCE' })
    }

    if (!identifier) {
      errors.push({ field: `items[${i}].identifier`, message: 'Identifier is required.', code: 'EMPTY_IDENTIFIER' })
    } else if (sourceType === 'fleet_maintained' && !FMA_ID_RE.test(identifier)) {
      errors.push({ field: `items[${i}].identifier`, message: 'A Fleet-maintained app Identifier must be the numeric Fleet-maintained app ID.', code: 'INVALID_IDENTIFIER' })
    } else if (seen.has(key)) {
      warnings.push({ field: `items[${i}].identifier`, message: `${identifier} is listed more than once for this team; the last one wins.`, code: 'DUPLICATE_IDENTIFIER' })
    } else {
      seen.add(key)
    }

    if (sourceType === 'app_store' && !PLATFORMS.has(platform)) {
      errors.push({ field: `items[${i}].platform`, message: `Platform must be one of darwin, ios, ipados, android (got "${platform}").`, code: 'INVALID_PLATFORM' })
    }

    if (!TEAM_ID_RE.test(teamId)) {
      errors.push({ field: `items[${i}].teamId`, message: 'Team ID must be numeric (use 0 for "Unassigned").', code: 'INVALID_TEAM_ID' })
    }

    if (!YES_NO.has(selfService)) {
      errors.push({ field: `items[${i}].selfService`, message: 'Self-Service must be yes or no.', code: 'INVALID_SELF_SERVICE' })
    } else if (platform === 'android' && selfService !== 'yes' && sourceType === 'app_store') {
      errors.push({ field: `items[${i}].selfService`, message: 'Self-Service is required (must be "yes") when Platform is Android.', code: 'SELF_SERVICE_REQUIRED_ANDROID' })
    }

    if (autoUpdateEnabled === 'yes') {
      if (sourceType !== 'app_store') {
        warnings.push({ field: `items[${i}].autoUpdateEnabled`, message: 'Auto-Update only applies to App Store apps and is ignored for Fleet-maintained apps.', code: 'AUTO_UPDATE_IGNORED' })
      }
      if (!TIME_RE.test(autoUpdateWindowStart)) {
        errors.push({ field: `items[${i}].autoUpdateWindowStart`, message: 'Auto-Update Window Start is required (HH:MM) when Auto-Update is Yes.', code: 'INVALID_AUTO_UPDATE_WINDOW' })
      }
      if (!TIME_RE.test(autoUpdateWindowEnd)) {
        errors.push({ field: `items[${i}].autoUpdateWindowEnd`, message: 'Auto-Update Window End is required (HH:MM) when Auto-Update is Yes.', code: 'INVALID_AUTO_UPDATE_WINDOW' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
