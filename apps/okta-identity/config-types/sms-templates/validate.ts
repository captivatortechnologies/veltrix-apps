import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Custom SMS Templates API constraints -------------------------------
//
// Custom SMS templates are repeatable items keyed by NAME:
//   GET    /api/v1/templates/sms          — list all custom SMS templates
//   POST   /api/v1/templates/sms          — create
//   PUT    /api/v1/templates/sms/{id}     — full replace (used for update)
//   DELETE /api/v1/templates/sms/{id}     — delete
// Only custom templates of type SMS_VERIFY_CODE exist — there are NO protected
// system SMS templates in this API. So, unlike network zones, an SMS template has
// no lifecycle/status and no protected-name list: this type is network-zones
// MINUS the lifecycle.

/** The only SMS template type Okta supports. */
export const SMS_TEMPLATE_TYPE = 'SMS_VERIFY_CODE'

/** An SMS template name is capped at 50 characters. */
export const MAX_NAME = 50

/** The SMS body — and every translation — is capped at 161 characters. */
export const MAX_TEMPLATE = 161

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SmsTemplateSpec {
  sectionName: string
  /** Template name — the logical identity deploy matches on. */
  name: string
  /** Template type — always SMS_VERIFY_CODE. */
  type: string
  /** The SMS body text, with macros like ${code} / ${org.name}. */
  template: string
  /**
   * Raw JSON string of translations: a JSON object mapping a 2-letter ISO-639-1
   * language code to the translated text (each <= 161 chars). Parsed to an object
   * and merged into the create/update body.
   */
  translationsJson?: string
}

/**
 * Shape of an SMS template returned by GET /templates/sms. Carries an index
 * signature so a live template can be handed to helpers typed as
 * `Record<string, unknown>`.
 */
export interface LiveSmsTemplate {
  id?: string
  name?: string
  template?: string
  type?: string
  translations?: Record<string, string>
  created?: string
  lastUpdated?: string
  _links?: unknown
  [k: string]: unknown
}

/**
 * Parse a raw JSON string into a translations object, returning the map when it
 * is a JSON OBJECT whose every value is a string, or null otherwise (a JSON
 * array, primitive, malformed input, or an object with a non-string value all
 * count as invalid). Shared by validate (to reject bad input), deploy (to build
 * the API body) and drift (to compare). The per-value length limit is enforced
 * separately by validate.
 */
export function parseTranslations(raw: string): Record<string, string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') return null
    out[key] = value
  }
  return out
}

/** Each canvas item describes one Okta custom SMS template. */
export function extractSmsTemplateSpecs(canvas: CanvasSnapshot): SmsTemplateSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const translationsJson =
      typeof fields.translationsJson === 'string' && fields.translationsJson.trim()
        ? fields.translationsJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      // type is an upper-case enum; normalise so a lower-case entry still matches.
      type: typeof fields.type === 'string' ? fields.type.trim().toUpperCase() : '',
      template: typeof fields.template === 'string' ? fields.template.trim() : '',
      translationsJson,
    }
  })
}

// --- Body helpers shared by deploy / rollback --------------------------------

/** Server-managed fields Okta returns on a template but that must never be sent back. */
export const READONLY_SMS_FIELDS = ['id', 'created', 'lastUpdated', '_links'] as const

/**
 * Build the create/update body. name/type/template always come from the modeled
 * fields; translations is included only when the map is non-empty so an omitted
 * translations block is not sent as an empty object.
 */
export function buildSmsTemplateBody(
  spec: SmsTemplateSpec,
  translations: Record<string, string> | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, type: spec.type, template: spec.template }
  if (translations && Object.keys(translations).length > 0) {
    body.translations = translations
  }
  return body
}

/** Copy a live template without the server-managed readOnly fields (safe to PUT back). */
export function stripReadOnlySmsFields(tpl: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(tpl)) {
    if (!(READONLY_SMS_FIELDS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom SMS template configurations against the Okta Templates API.
 * Static only — it never contacts Okta:
 *   - name is required, <= 50 chars, and unique within the canvas (case-insensitive)
 *   - type is exactly SMS_VERIFY_CODE
 *   - template is required and <= 161 chars
 *   - translations (when set) parse to a JSON OBJECT of string values, each <= 161 chars
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSmsTemplateSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 50 chars, unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Template name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME) {
        errors.push({
          field: `${prefix}.name`,
          message: `Template name must be ${MAX_NAME} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate template "${spec.name}" — each template may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type — must be exactly SMS_VERIFY_CODE (covers both missing and wrong)
    if (spec.type !== SMS_TEMPLATE_TYPE) {
      errors.push({
        field: `${prefix}.type`,
        message: `Template type must be ${SMS_TEMPLATE_TYPE}`,
        code: 'invalid_type',
      })
    }

    // template — required, <= 161 chars
    if (!spec.template) {
      errors.push({ field: `${prefix}.template`, message: 'Template text is required', code: 'required' })
    } else if (spec.template.length > MAX_TEMPLATE) {
      errors.push({
        field: `${prefix}.template`,
        message: `Template text must be ${MAX_TEMPLATE} characters or fewer`,
        code: 'max_length',
      })
    }

    // translations — when set, must parse to a JSON object of string values, each <= 161 chars
    if (spec.translationsJson) {
      const translations = parseTranslations(spec.translationsJson)
      if (translations === null) {
        errors.push({
          field: `${prefix}.translationsJson`,
          message:
            'Translations must be a valid JSON object mapping a language code to text, e.g. {"es":"Tu codigo es ${code}"}',
          code: 'invalid_translations',
        })
      } else {
        const tooLong = Object.entries(translations).find(([, text]) => text.length > MAX_TEMPLATE)
        if (tooLong) {
          errors.push({
            field: `${prefix}.translationsJson`,
            message: `Translation "${tooLong[0]}" must be ${MAX_TEMPLATE} characters or fewer`,
            code: 'invalid_translations',
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
