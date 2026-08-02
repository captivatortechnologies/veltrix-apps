import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readKeyValueMap, readString } from '../../lib/fields'
import { SIGNING_ALGS, TOKEN_LIFETIME_MAX } from './_shared'

/**
 * Validate Auth0 resource server (API) items: a non-empty name (Auth0 forbids
 * `<`/`>`), a non-empty identifier (audience), a known signing algorithm, and an
 * in-range integer token lifetime. Static — no target access required. The API
 * name is the upsert identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one API.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = readString(item.fields.name)
    const identifier = readString(item.fields.identifier)
    const signingAlg = readString(item.fields.signing_alg)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'API name is required.', code: 'EMPTY_NAME' })
    } else {
      if (/[<>]/.test(name)) {
        errors.push({ field: `items[${i}].name`, message: `API name "${name}" must not contain < or >.`, code: 'INVALID_NAME' })
      }
      if (seen.has(name)) {
        warnings.push({ field: `items[${i}].name`, message: `API name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(name)
      }
    }

    if (!identifier) {
      errors.push({ field: `items[${i}].identifier`, message: 'API identifier (audience) is required.', code: 'EMPTY_IDENTIFIER' })
    } else if (identifier.length > 600) {
      errors.push({ field: `items[${i}].identifier`, message: 'API identifier must be 600 characters or fewer.', code: 'INVALID_IDENTIFIER' })
    }

    if (!SIGNING_ALGS.has(signingAlg)) {
      errors.push({
        field: `items[${i}].signing_alg`,
        message: `Signing algorithm must be one of HS256, RS256, RS512, PS256 (got "${signingAlg}").`,
        code: 'INVALID_SIGNING_ALG',
      })
    }

    const rawLifetime = item.fields.token_lifetime
    if (rawLifetime !== undefined && rawLifetime !== null && rawLifetime !== '') {
      const n = typeof rawLifetime === 'number' ? rawLifetime : Number(String(rawLifetime).trim())
      if (!Number.isInteger(n) || n < 0 || n > TOKEN_LIFETIME_MAX) {
        errors.push({
          field: `items[${i}].token_lifetime`,
          message: `Token lifetime must be an integer between 0 and ${TOKEN_LIFETIME_MAX} seconds (got "${String(rawLifetime)}").`,
          code: 'INVALID_TOKEN_LIFETIME',
        })
      }
    }

    for (const value of Object.keys(readKeyValueMap(item.fields.scopes))) {
      if (/\s/.test(value)) {
        errors.push({
          field: `items[${i}].scopes`,
          message: `Scope value "${value}" must not contain whitespace.`,
          code: 'INVALID_SCOPE',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
