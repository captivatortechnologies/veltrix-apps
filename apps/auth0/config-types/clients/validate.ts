import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { APP_TYPES, TOKEN_AUTH_METHODS, parseList } from './_shared'

/**
 * Validate Auth0 client items: a non-empty name (Auth0 forbids `<`/`>`), a known
 * application type, a known token endpoint auth method, and absolute http(s) URLs
 * in every URL list. Static — no target access required. The client name is the
 * upsert identity, so a duplicate name is flagged (last one wins).
 */
const URL_RE = /^https?:\/\/.+/i

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one application.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const appType = String(item.fields.app_type ?? '').trim()
    const tokenAuth = String(item.fields.token_endpoint_auth_method ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Application name is required.', code: 'EMPTY_NAME' })
    } else {
      if (/[<>]/.test(name)) {
        errors.push({ field: `items[${i}].name`, message: `Application name "${name}" must not contain < or >.`, code: 'INVALID_NAME' })
      }
      if (seen.has(name)) {
        warnings.push({ field: `items[${i}].name`, message: `Application name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(name)
      }
    }

    if (!APP_TYPES.has(appType)) {
      errors.push({
        field: `items[${i}].app_type`,
        message: `Application type must be one of spa, native, regular_web, non_interactive (got "${appType}").`,
        code: 'INVALID_APP_TYPE',
      })
    }

    if (!TOKEN_AUTH_METHODS.has(tokenAuth)) {
      errors.push({
        field: `items[${i}].token_endpoint_auth_method`,
        message: `Token endpoint auth method must be one of none, client_secret_post, client_secret_basic (got "${tokenAuth}").`,
        code: 'INVALID_TOKEN_AUTH_METHOD',
      })
    }

    for (const key of ['callbacks', 'allowed_logout_urls', 'web_origins'] as const) {
      for (const url of parseList(item.fields[key])) {
        if (!URL_RE.test(url)) {
          errors.push({
            field: `items[${i}].${key}`,
            message: `"${url}" must be an absolute http(s) URL.`,
            code: 'INVALID_URL',
          })
        }
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
