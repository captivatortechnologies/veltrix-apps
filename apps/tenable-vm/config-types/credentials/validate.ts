import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Credentials API constraints -------------------------------------

/** Credential name / description length caps (Tenable console limits). */
export const MAX_CREDENTIAL_NAME_LENGTH = 255
export const MAX_CREDENTIAL_DESCRIPTION_LENGTH = 1000

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface CredentialSpec {
  sectionName: string
  /** Credential name — the logical identity we match live credentials on. */
  name: string
  /** Credential-type slug (e.g. "SSH", "Windows"); fixed at create time. */
  type: string
  description?: string
  /**
   * Raw per-type settings JSON string. Holds WRITE-ONLY secrets (password,
   * private_key, secret) that Tenable never returns on read — see driftDetect.
   * Absent/blank is rejected by validate (a credential needs its settings).
   */
  settingsJson?: string
}

/**
 * Shape of a credential returned by GET /credentials (list) and
 * GET /credentials/{uuid} (get). NOTE: `settings` is deliberately NOT modelled
 * here — Tenable never returns the secret-bearing settings on read, so no
 * handler can (or should) read it back.
 */
export interface LiveCredential {
  uuid?: string
  name?: string
  type?: string
  description?: string
}

/** Each canvas section describes one Tenable credential. */
export function extractCredentialSpecs(canvas: CanvasSnapshot): CredentialSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const settingsJson =
      typeof fields.settingsJson === 'string' && fields.settingsJson.trim()
        ? fields.settingsJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      type: typeof fields.type === 'string' ? fields.type.trim() : '',
      description,
      settingsJson,
    }
  })
}

/**
 * Parse a raw settings string, returning the object or null when the string is
 * not a JSON object (a JSON array or primitive counts as invalid too).
 * Shared by validate (to reject bad input) and deploy (to build the API body).
 */
export function parseSettingsObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate credential configurations against Tenable Credentials API
 * constraints: a name and type are required (name capped at 255 chars), the
 * per-type settings must be a JSON object, and the credential NAME — a
 * credential's logical identity — must be unique across the canvas.
 *
 * Static rules only — NO network. In particular this does NOT (cannot) verify
 * the secret values inside settingsJson: they are write-only and never
 * returned by the API.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCredentialSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, and the logical identity
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Credential name is required', code: 'required' })
    } else if (spec.name.length > MAX_CREDENTIAL_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Credential name must be ${MAX_CREDENTIAL_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // description — optional, capped length
    if (spec.description && spec.description.length > MAX_CREDENTIAL_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_CREDENTIAL_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // type — required credential-type slug (validated live via GET /credentials/types)
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Credential type is required', code: 'required' })
    } else if (spec.type.length > MAX_CREDENTIAL_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.type`,
        message: `Credential type must be ${MAX_CREDENTIAL_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // settingsJson — required, and must parse as a JSON object. We intentionally
    // do NOT inspect its contents: secret fields are write-only and per-type.
    if (!spec.settingsJson) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message: 'Settings JSON is required — a credential needs its type-specific settings',
        code: 'required',
      })
    } else if (parseSettingsObject(spec.settingsJson) === null) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message:
          'Settings must be a valid JSON object, e.g. {"auth_method":"password","username":"svc","password":"…"}',
        code: 'invalid_settings',
      })
    }

    // Credential NAME is the logical identity — dedupe on it. Matched exactly
    // (not case-folded) so it agrees with the name-based live match in deploy /
    // drift; two names differing only in case are treated as distinct.
    if (spec.name) {
      const key = spec.name
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate credential "${spec.name}" — each credential name may only be declared once per canvas`,
          code: 'duplicate_credential',
        })
      }
      seenNames.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
