import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonObject, readString } from '../../lib/fields'
import { ENABLED_CONNECTION_FLAGS, THIRD_PARTY_CLIENT_ACCESS } from './_shared'

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/

/**
 * Validate Auth0 organization items: a non-empty name matching Auth0's naming
 * rule (1–50 chars, lowercase alphanumeric + hyphens, alphanumeric at each end),
 * well-formed hex colors, a known third-party-client-access mode, valid JSON for
 * token_quota, and well-formed enabled-connection lines. Static — no target
 * access required. The organization name is the upsert identity, so a duplicate
 * name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one organization.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = readString(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Organization name is required.', code: 'EMPTY_NAME' })
    } else {
      if (name.length > 50 || !NAME_RE.test(name)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Organization name "${name}" must be 1–50 characters, lowercase letters, numbers and hyphens, starting and ending with an alphanumeric character.`,
          code: 'INVALID_NAME',
        })
      }
      if (seen.has(name)) {
        warnings.push({ field: `items[${i}].name`, message: `Organization name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(name)
      }
    }

    for (const key of ['colors_primary', 'colors_page_background'] as const) {
      const value = readString(item.fields[key])
      if (value && !HEX_COLOR_RE.test(value)) {
        errors.push({ field: `items[${i}].${key}`, message: `"${value}" must be a 6-digit hex color, e.g. #635DFF.`, code: 'INVALID_COLOR' })
      }
    }

    const access = readString(item.fields.third_party_client_access)
    if (access && !THIRD_PARTY_CLIENT_ACCESS.has(access)) {
      errors.push({
        field: `items[${i}].third_party_client_access`,
        message: `Third-party client access must be "allow" or "block" (got "${access}").`,
        code: 'INVALID_ACCESS_MODE',
      })
    }

    const tokenQuota = parseJsonObject(item.fields.token_quota)
    if (!tokenQuota.ok) {
      errors.push({ field: `items[${i}].token_quota`, message: `Token quota ${tokenQuota.error}.`, code: 'INVALID_TOKEN_QUOTA' })
    }

    const rawConnections = item.fields.enabled_connections
    const lines = typeof rawConnections === 'string' ? rawConnections.split(/[\r\n]+/) : []
    lines.forEach((line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      const [idPart, flagsPart] = trimmed.split('|')
      if (!idPart.trim()) {
        errors.push({ field: `items[${i}].enabled_connections`, message: `"${trimmed}" is missing a connection id.`, code: 'INVALID_ENABLED_CONNECTION' })
        return
      }
      for (const flag of (flagsPart ?? '').split(',').map((f) => f.trim()).filter(Boolean)) {
        if (!ENABLED_CONNECTION_FLAGS.has(flag)) {
          errors.push({
            field: `items[${i}].enabled_connections`,
            message: `"${flag}" is not a recognized flag (expected one of ${[...ENABLED_CONNECTION_FLAGS].join(', ')}).`,
            code: 'INVALID_ENABLED_CONNECTION_FLAG',
          })
        }
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
