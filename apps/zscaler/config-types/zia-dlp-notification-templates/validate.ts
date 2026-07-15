import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA DLP Notification Templates constraints ------------------------------

/** ZIA caps a DLP notification template name at 255 characters. */
export const MAX_TEMPLATE_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface DlpTemplateSpec {
  sectionName: string
  /** The template name — its logical identity (list + match). */
  name: string
  /** Subject line of the notification email. */
  subject: string
  /** Plain-text body (required — sent to clients that do not render HTML). */
  plainTextMessage: string
  /** Optional HTML body. */
  htmlMessage?: string
  /** Whether the notification email is delivered over TLS (defaults false). */
  tlsEnabled: boolean
  /** Whether triggering content is attached to the email (defaults true). */
  attachContent: boolean
}

/** Shape of a DLP notification template returned by GET /dlpNotificationTemplates. */
export interface LiveDlpTemplate {
  id?: number
  name?: string
  subject?: string
  plainTextMessage?: string
  htmlMessage?: string
  tlsEnabled?: boolean
  attachContent?: boolean
}

/** Coerce a canvas boolean field, falling back when unset (booleans may arrive as strings). */
export function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

/** Each canvas item describes one ZIA DLP notification template. */
export function extractDlpTemplateSpecs(canvas: CanvasSnapshot): DlpTemplateSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const htmlMessage =
      typeof fields.html_message === 'string' && fields.html_message.trim()
        ? fields.html_message.trim()
        : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      subject: typeof fields.subject === 'string' ? fields.subject.trim() : '',
      plainTextMessage:
        typeof fields.plain_text_message === 'string' ? fields.plain_text_message.trim() : '',
      htmlMessage,
      tlsEnabled: readBoolean(fields.tls_enabled, false),
      // ZIA defaults attach_content on; keep that unless the author turns it off.
      attachContent: readBoolean(fields.attach_content, true),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate DLP notification template configurations against ZIA constraints: a
 * name is required and capped at 255 chars, a subject and a plain-text message
 * are required, and the name — a template's logical identity — must be unique
 * across the canvas (matched case-insensitively, since ZIA rejects templates
 * differing only in case).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDlpTemplateSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'DLP notification template name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_TEMPLATE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `DLP notification template name must be ${MAX_TEMPLATE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate DLP notification template "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_dlp_template',
        })
      }
      seen.add(key)
    }

    if (!spec.subject) {
      errors.push({ field: `${prefix}.subject`, message: 'Subject is required', code: 'required' })
    }

    if (!spec.plainTextMessage) {
      errors.push({
        field: `${prefix}.plain_text_message`,
        message: 'Plain text message is required',
        code: 'required',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
