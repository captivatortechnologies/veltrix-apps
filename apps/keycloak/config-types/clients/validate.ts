import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PROTOCOLS, normalizeBool, parseRedirectUris } from './_shared'

/**
 * Validate client items: a non-empty clientId with no whitespace, a known
 * protocol, and — when standard flow is enabled — at least one redirect URI.
 * Static (no target access). clientId is the client's identity, so a duplicate is
 * flagged (last one wins).
 */
const CLIENT_ID_RE = /^[^\s]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one client.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const clientId = String(item.fields.clientId ?? '').trim()
    const protocol = String(item.fields.protocol ?? '').trim()

    if (!clientId) {
      errors.push({ field: `items[${i}].clientId`, message: 'Client ID is required.', code: 'EMPTY_CLIENT_ID' })
    } else if (!CLIENT_ID_RE.test(clientId)) {
      errors.push({
        field: `items[${i}].clientId`,
        message: `Client ID "${clientId}" must not contain whitespace.`,
        code: 'INVALID_CLIENT_ID',
      })
    } else if (seen.has(clientId)) {
      warnings.push({
        field: `items[${i}].clientId`,
        message: `Client ID ${clientId} is listed more than once; the last one wins.`,
        code: 'DUPLICATE_CLIENT_ID',
      })
    } else {
      seen.add(clientId)
    }

    if (!PROTOCOLS.has(protocol)) {
      errors.push({
        field: `items[${i}].protocol`,
        message: `Protocol must be one of openid-connect, saml (got "${protocol}").`,
        code: 'INVALID_PROTOCOL',
      })
    }

    const standardFlow = normalizeBool(item.fields.standardFlowEnabled, true)
    const redirectUris = parseRedirectUris(item.fields.redirectUris)
    if (standardFlow && redirectUris.length === 0) {
      warnings.push({
        field: `items[${i}].redirectUris`,
        message: 'Standard flow is enabled but no redirect URI is set — login redirects will be rejected.',
        code: 'MISSING_REDIRECT_URI',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
