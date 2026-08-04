import type { PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractWebhookSpecs, webhookKey, type WebhookSpec } from './_shared'

/**
 * Validate JFrog Xray webhook items. Static — no target access required.
 *   - Webhook name is required and must be safe to use as a URL path segment
 *     (it is one — `/xray/api/v1/webhooks/{name}`); duplicate names are
 *     rejected (the name is the upsert identity, and is what a policy's
 *     "Webhooks" action list references).
 *   - Target URL is required and must be a well-formed http(s) URL.
 *   - A username without a password (or vice versa) is a warning, not an
 *     error — Xray's API does not document either as strictly required
 *     together, and an operator may intentionally use only one.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractWebhookSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one webhook.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    validateIdentity(spec, prefix, errors, seen)
    validateUrl(spec, prefix, errors)
    validateAuth(spec, prefix, warnings)
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateIdentity(spec: WebhookSpec, prefix: string, errors: ValidationError[], seen: Set<string>): void {
  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Webhook name is required.', code: 'EMPTY_NAME' })
    return
  }
  if (/[/\\]/.test(spec.name)) {
    errors.push({ field: `${prefix}.name`, message: `Webhook name "${spec.name}" must not contain "/" or "\\" — it is used directly in the API URL.`, code: 'INVALID_NAME' })
  }
  const key = webhookKey(spec.name)
  if (seen.has(key)) {
    errors.push({ field: `${prefix}.name`, message: `Duplicate webhook name "${spec.name}" — each name may only be declared once.`, code: 'DUPLICATE_NAME' })
  }
  seen.add(key)
}

function validateUrl(spec: WebhookSpec, prefix: string, errors: ValidationError[]): void {
  if (!spec.url) {
    errors.push({ field: `${prefix}.url`, message: 'Target URL is required.', code: 'EMPTY_URL' })
    return
  }
  try {
    const parsed = new URL(spec.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push({ field: `${prefix}.url`, message: `Target URL "${spec.url}" must use http or https.`, code: 'INVALID_URL' })
    }
  } catch {
    errors.push({ field: `${prefix}.url`, message: `Target URL "${spec.url}" is not a well-formed URL.`, code: 'INVALID_URL' })
  }
}

function validateAuth(spec: WebhookSpec, prefix: string, warnings: ValidationWarning[]): void {
  if (spec.userName && !spec.password) {
    warnings.push({ field: `${prefix}.password`, message: 'A username is set without a password.', code: 'INCOMPLETE_AUTH' })
  }
  if (!spec.userName && spec.password) {
    warnings.push({ field: `${prefix}.user_name`, message: 'A password is set without a username.', code: 'INCOMPLETE_AUTH' })
  }
}
