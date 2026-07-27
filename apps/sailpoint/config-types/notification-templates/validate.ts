import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Notification Template constraints -------------------------
// Composite-keyed by (key + medium + locale). There is no PATCH/PUT: creating a
// template replaces the custom override for that triple, and reconcile removes
// app-created triples via bulk-delete.

export const MEDIA = ['EMAIL', 'SLACK', 'TEAMS'] as const

export interface NotificationTemplateSpec {
  itemId?: string
  /** the template key, e.g. "cloud_manual_work_item_summary". */
  key: string
  name: string
  medium: string
  locale: string
  subject: string
  body: string
  from: string
  replyTo: string
  description: string
}

/** A template as returned by GET /beta/notification-templates. */
export interface LiveNotificationTemplate {
  key?: string
  name?: string
  medium?: string
  locale?: string
  subject?: string
  body?: string
  from?: string
  replyTo?: string
  description?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function compositeKey(key: string, medium: string, locale: string): string {
  return `${key.toLowerCase()}::${medium.toUpperCase()}::${locale.toLowerCase()}`
}

export function extractNotificationTemplateSpecs(canvas: CanvasSnapshot): NotificationTemplateSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      key: asString(f.key) || item.name,
      name: asString(f.name),
      medium: (asString(f.medium) || 'EMAIL').toUpperCase(),
      locale: asString(f.locale) || 'en',
      subject: asString(f.subject),
      body: typeof f.body === 'string' ? f.body : '',
      from: asString(f.from),
      replyTo: asString(f.replyTo),
      description: asString(f.description),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractNotificationTemplateSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.key) {
      errors.push({ field: `${prefix}.key`, message: 'A template key is required', code: 'required' })
    }
    if (!MEDIA.includes(spec.medium as (typeof MEDIA)[number])) {
      errors.push({ field: `${prefix}.medium`, message: `Medium must be one of ${MEDIA.join(', ')}`, code: 'invalid_enum' })
    }
    if (!spec.locale) {
      errors.push({ field: `${prefix}.locale`, message: 'A locale is required (e.g. "en")', code: 'required' })
    }

    if (spec.key && spec.medium && spec.locale) {
      const ck = compositeKey(spec.key, spec.medium, spec.locale)
      if (seen.has(ck)) {
        errors.push({ field: `${prefix}.key`, message: `Duplicate template "${spec.key}" (${spec.medium}/${spec.locale}) — each key+medium+locale may only be declared once`, code: 'duplicate_key' })
      }
      seen.add(ck)
    }

    if (spec.key && !spec.body.trim()) {
      warnings.push({ field: `${prefix}.body`, message: `Template "${spec.key}" has an empty body`, code: 'empty_body' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
