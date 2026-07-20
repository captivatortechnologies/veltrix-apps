import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta CAPTCHA API constraints --------------------------------------------
//
// An org supports AT MOST ONE CAPTCHA instance. Two resources are managed:
//   /api/v1/captchas[/{id}]  — the instance (name, type, siteKey, secretKey[write-only])
//   /api/v1/org/captcha      — org-wide enablement ({captchaId, enabledPages})
// secretKey is write-only (never returned), so it is re-asserted every deploy and
// excluded from drift.

/** CAPTCHA providers Okta supports. */
export const CAPTCHA_TYPES = ['HCAPTCHA', 'RECAPTCHA_V2'] as const

/** End-user pages the org-wide CAPTCHA can protect. */
export const CAPTCHA_ENABLED_PAGES = ['SIGN_IN', 'SSPR', 'SSR'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface CaptchaSpec {
  sectionName: string
  /** Instance name. */
  name: string
  /** Provider — HCAPTCHA | RECAPTCHA_V2. */
  type: string
  /** Public site key (rendered in the browser). */
  siteKey: string
  /**
   * WRITE-ONLY secret key. Okta NEVER returns it, so it is re-asserted on every
   * deploy and excluded from drift. Preserved verbatim (it may contain punctuation).
   */
  secretKey?: string
  /** Org-wide pages the CAPTCHA is enforced on (empty disables it org-wide). */
  enabledPages: string[]
}

/** Shape of a CAPTCHA instance returned by GET /captchas. secretKey is never present. */
export interface LiveCaptchaInstance {
  id?: string
  name?: string
  type?: string
  siteKey?: string
  _links?: unknown
  [key: string]: unknown
}

/** Shape of GET /org/captcha (empty object when unconfigured). */
export interface LiveOrgCaptcha {
  captchaId?: string | null
  enabledPages?: string[] | null
  _links?: unknown
  [key: string]: unknown
}

/** Canvas list fields (multiselect/tags) arrive as arrays, or comma/newline text. */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/**
 * Preserve a secret's EXACT characters, but treat a whitespace-only value as
 * blank (undefined). Mirrors the event-hooks write-only-secret handling.
 */
export function preserveSecret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim().length > 0 ? value : undefined
}

/**
 * Extract the CAPTCHA spec(s). It is a singleton, so a well-formed canvas has
 * exactly one item; all are returned so validate can flag a canvas that declares
 * more than one.
 */
export function extractCaptchaSpecs(canvas: CanvasSnapshot): CaptchaSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      type: typeof fields.type === 'string' ? fields.type.trim().toUpperCase() : '',
      siteKey: typeof fields.siteKey === 'string' ? fields.siteKey.trim() : '',
      secretKey: preserveSecret(fields.secretKey),
      enabledPages: [...new Set(toStringList(fields.enabledPages).map((p) => p.toUpperCase()))],
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate the CAPTCHA configuration against the Okta CAPTCHA API. Static only —
 * it never contacts Okta:
 *   - exactly one configuration may be declared (an org supports one instance)
 *   - name, site key and provider are required; provider is HCAPTCHA | RECAPTCHA_V2
 *   - the secret key (WRITE-ONLY) is required and re-asserted on every deploy
 *   - enabledPages (when set) are among SIGN_IN | SSPR | SSR
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCaptchaSpecs(ctx.canvas)

  if (specs.length > 1) {
    errors.push({
      field: 'sections',
      message: 'An Okta org supports a single CAPTCHA instance — declare exactly one configuration',
      code: 'singleton',
    })
  }

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Instance name is required', code: 'required' })
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Provider is required', code: 'required' })
    } else if (!(CAPTCHA_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Provider must be one of: ${CAPTCHA_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    if (!spec.siteKey) {
      errors.push({ field: `${prefix}.siteKey`, message: 'Site key is required', code: 'required' })
    }

    if (!spec.secretKey) {
      errors.push({
        field: `${prefix}.secretKey`,
        message:
          'Secret key is required — it is a write-only secret Okta never returns, so it must be re-entered and is re-sent on every deploy',
        code: 'required',
      })
    }

    for (const page of spec.enabledPages) {
      if (!(CAPTCHA_ENABLED_PAGES as readonly string[]).includes(page)) {
        errors.push({
          field: `${prefix}.enabledPages`,
          message: `Enabled pages must be among: ${CAPTCHA_ENABLED_PAGES.join(', ')}`,
          code: 'invalid_page',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
