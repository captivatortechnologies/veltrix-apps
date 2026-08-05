import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractCredentialSpecs, CREDENTIAL_MODES, READ_ACCESS_VALUES } from './_shared'

/**
 * Validate Credential items. Static — no target access required:
 *   - name, team_id and mode are required; mode must be a supported value
 *   - (team_id, name) must be unique across the canvas (its reconciliation identity)
 *   - SPECIFIC_TEAMS read_access requires at least one shared_team_slugs entry
 *   - blank secret material is only a WARNING — this app can't know statically
 *     whether the credential already exists, and a blank value on an EXISTING
 *     credential intentionally leaves its secret unchanged (see _shared.ts)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractCredentialSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one credential.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Credential name is required.', code: 'EMPTY_NAME' })
    }
    if (!spec.teamId) {
      errors.push({ field: `${prefix}.team_id`, message: 'Team is required.', code: 'EMPTY_TEAM' })
    }
    if (!spec.mode) {
      errors.push({ field: `${prefix}.mode`, message: 'Mode is required.', code: 'EMPTY_MODE' })
    } else if (!(CREDENTIAL_MODES as readonly string[]).includes(spec.mode)) {
      errors.push({
        field: `${prefix}.mode`,
        message: `Mode must be one of: ${CREDENTIAL_MODES.join(', ')} (HTTP Request and Multi Request modes are not supported — see the app README).`,
        code: 'INVALID_MODE',
      })
    }
    if (!(READ_ACCESS_VALUES as readonly string[]).includes(spec.readAccess)) {
      errors.push({
        field: `${prefix}.read_access`,
        message: `read_access must be one of: ${READ_ACCESS_VALUES.join(', ')}.`,
        code: 'INVALID_READ_ACCESS',
      })
    } else if (spec.readAccess === 'SPECIFIC_TEAMS' && spec.sharedTeamSlugs.length === 0) {
      errors.push({
        field: `${prefix}.shared_team_slugs`,
        message: 'At least one team slug is required when Read Access is Specific teams.',
        code: 'EMPTY_SHARED_TEAMS',
      })
    }

    const hasMaterial = spec.mode === 'TEXT' ? Boolean(spec.secretValue) : Object.keys(spec.secretConfig).length > 0
    if (spec.mode && !hasMaterial) {
      warnings.push({
        field: `${prefix}`,
        message: `Secret material is blank — Tines requires it when creating a NEW ${spec.mode} credential; an EXISTING credential keeps its current secret unchanged.`,
        code: 'SECRET_BLANK',
      })
    }

    if (spec.name && spec.teamId) {
      const key = `${spec.teamId}::${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.name`,
          message: `Credential "${spec.name}" is listed more than once for this team; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
