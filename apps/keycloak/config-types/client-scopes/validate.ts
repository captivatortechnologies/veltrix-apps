import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { REALM_DEFAULT_STATES } from './_shared'

/**
 * Validate client-scope items: a non-empty scope name with no whitespace (OAuth2's
 * "scope" request parameter is space-delimited, so a name containing whitespace
 * could never be requested), a known protocol, an integer GUI order when set, and
 * a known realm-assignment state. Static (no target access). The scope name is
 * the identity, so a duplicate is flagged (last one wins).
 */
const SCOPE_NAME_RE = /^[^\s]+$/
const PROTOCOLS = new Set(['openid-connect', 'saml'])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one client scope.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = readString(item.fields.name)
    const protocol = readString(item.fields.protocol)
    const realmDefault = readString(item.fields.realmDefault) || 'none'
    const rawGuiOrder = item.fields.guiOrder

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Scope name is required.', code: 'EMPTY_SCOPE_NAME' })
    } else if (!SCOPE_NAME_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Scope name "${name}" must not contain whitespace — OAuth2's "scope" request parameter is space-delimited.`,
        code: 'INVALID_SCOPE_NAME',
      })
    } else if (seen.has(name)) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Scope name ${name} is listed more than once; the last one wins.`,
        code: 'DUPLICATE_SCOPE_NAME',
      })
    } else {
      seen.add(name)
    }

    if (!PROTOCOLS.has(protocol)) {
      errors.push({
        field: `items[${i}].protocol`,
        message: `Protocol must be one of openid-connect, saml (got "${protocol}").`,
        code: 'INVALID_PROTOCOL',
      })
    }

    if (rawGuiOrder !== '' && rawGuiOrder !== null && rawGuiOrder !== undefined) {
      const n = Number(rawGuiOrder)
      if (!Number.isInteger(n)) {
        errors.push({
          field: `items[${i}].guiOrder`,
          message: `GUI order must be an integer (got "${String(rawGuiOrder)}").`,
          code: 'INVALID_GUI_ORDER',
        })
      }
    }

    if (!REALM_DEFAULT_STATES.has(realmDefault)) {
      errors.push({
        field: `items[${i}].realmDefault`,
        message: `Realm assignment must be one of none, default, optional (got "${realmDefault}").`,
        code: 'INVALID_REALM_DEFAULT',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
