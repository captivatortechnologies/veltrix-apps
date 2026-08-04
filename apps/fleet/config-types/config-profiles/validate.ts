import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PLATFORMS, parseLabelList } from './_shared'

/**
 * Validate configuration-profile items: a safe name, a known platform, non-empty
 * content, a display name when the platform requires one, a numeric (or blank)
 * team id, and mutually-exclusive label targeting. Static — no target access
 * required.
 */
const NAME_RE = /^[A-Za-z0-9 ._:-]+$/
const TEAM_ID_RE = /^[0-9]*$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one configuration profile.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const platform = String(item.fields.platform ?? 'macos').trim().toLowerCase()
    const displayName = String(item.fields.displayName ?? '').trim()
    const profileContent = String(item.fields.profileContent ?? '').trim()
    const teamId = String(item.fields.teamId ?? '').trim()
    const labelsIncludeAll = parseLabelList(item.fields.labelsIncludeAll)
    const labelsIncludeAny = parseLabelList(item.fields.labelsIncludeAny)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Name "${name}" may only contain letters, numbers, space, dot, underscore, colon or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Profile ${name} is listed more than once; the batch replace keeps only the last one.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!PLATFORMS.has(platform)) {
      errors.push({ field: `items[${i}].platform`, message: `Platform must be one of macos, windows (got "${platform}").`, code: 'INVALID_PLATFORM' })
    }

    if (!profileContent) {
      errors.push({ field: `items[${i}].profileContent`, message: 'Profile Content is required.', code: 'EMPTY_CONTENT' })
    } else if (platform === 'macos' && !/^\s*(<\?xml|\{)/.test(profileContent)) {
      warnings.push({
        field: `items[${i}].profileContent`,
        message: 'macOS/iOS profile content does not look like an XML plist (.mobileconfig) or a JSON declaration (DDM) — verify it matches what Fleet expects.',
        code: 'UNVERIFIED_CONTENT_SHAPE',
      })
    } else if (platform === 'windows' && !/^\s*<\?xml/.test(profileContent) && !/^\s*<\w+/.test(profileContent)) {
      warnings.push({
        field: `items[${i}].profileContent`,
        message: 'Windows profile content does not look like XML/SyncML — verify it matches what Fleet expects.',
        code: 'UNVERIFIED_CONTENT_SHAPE',
      })
    }

    if (platform === 'windows' && !displayName) {
      errors.push({ field: `items[${i}].displayName`, message: 'Display Name is required for Windows profiles.', code: 'MISSING_DISPLAY_NAME' })
    }

    if (!TEAM_ID_RE.test(teamId)) {
      errors.push({ field: `items[${i}].teamId`, message: 'Team ID must be numeric, or blank for "Unassigned".', code: 'INVALID_TEAM_ID' })
    }

    const labelGroupsSet = [labelsIncludeAll.length > 0, labelsIncludeAny.length > 0].filter(Boolean).length
    if (labelGroupsSet > 1) {
      errors.push({
        field: `items[${i}].labelsIncludeAll`,
        message: 'Labels — Include All and Labels — Include Any are mutually exclusive; set only one.',
        code: 'CONFLICTING_LABEL_TARGETING',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
