import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk webhooks — org-scoped outbound webhooks via the v1 API
// (GET/POST/DELETE /org/{orgId}/webhooks). Webhooks CANNOT be updated in place;
// identity is the URL (natural key). The signing secret is WRITE-ONLY — it is
// only sent on create, never read back, never diffed, never stored in rollback
// data or artifacts.
// =============================================================================

export interface WebhookSpec {
  sectionName: string
  url: string
  /** The signing secret — write-only; present only for new webhooks. */
  secret: string
}

/** A webhook as returned by GET /org/{orgId}/webhooks (secret never included). */
export interface LiveWebhook {
  id?: string
  url?: string
}

/** The URL is a webhook's logical identity. */
export function webhookKey(url: string): string {
  return url.trim().toLowerCase()
}

/** Validate that a string is a well-formed https URL; returns an error string or null. */
export function checkHttpsUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return 'must be a valid URL'
  }
  if (parsed.protocol !== 'https:') return 'must use https://'
  return null
}

export function extractWebhookSpecs(canvas: CanvasSnapshot): WebhookSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      url: typeof fields.url === 'string' ? fields.url.trim() : '',
      secret: typeof fields.secret === 'string' ? fields.secret : '',
    }
  })
}

/**
 * Validate webhook configurations: a valid https URL and a signing secret are
 * required, and each URL may only be declared once.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no webhook items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractWebhookSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.url) {
      errors.push({ field: `${prefix}.url`, message: 'Webhook URL is required', code: 'required' })
    } else {
      const urlError = checkHttpsUrl(spec.url)
      if (urlError) errors.push({ field: `${prefix}.url`, message: `Webhook URL ${urlError}`, code: 'invalid_url' })
    }

    if (!spec.secret) {
      errors.push({
        field: `${prefix}.secret`,
        message: 'A signing secret is required — Snyk uses it to sign webhook payloads',
        code: 'required',
      })
    }

    if (spec.url) {
      const key = webhookKey(spec.url)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.url`, message: `Duplicate webhook URL "${spec.url}"`, code: 'duplicate_webhook' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
