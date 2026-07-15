import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Authorization Servers API constraints ------------------------------

/** A custom authorization server is ACTIVE or INACTIVE; changed via lifecycle. */
export const AUTH_SERVER_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** The issuer modes Okta supports for a custom authorization server. */
export const ISSUER_MODES = ['ORG_URL', 'CUSTOM_URL', 'DYNAMIC'] as const

/** Okta caps a custom authorization server name at 40 characters. */
export const MAX_AUTH_SERVER_NAME_LENGTH = 40

/**
 * Okta seeds every org with ONE built-in "default" custom authorization server
 * whose id is literally `default`. It is Okta-provided and PROTECTED: it may be
 * updated in place but must NEVER be deleted or recreated. Its identity is not a
 * name we can statically detect (the guard is id-based and lives in deploy /
 * rollback), but the default server is also named `default`, so validate WARNS
 * when a canvas item's name suggests the default server.
 */
export const PROTECTED_SERVER_ID = 'default'

/** True when `id` is the Okta-provided default authorization server (id === 'default'). */
export function isProtectedServerId(id: string | undefined): boolean {
  return (id ?? '').trim().toLowerCase() === PROTECTED_SERVER_ID
}

/**
 * True when a canvas item's NAME suggests the Okta default authorization server
 * (the built-in server is named `default`). Authoring a server named "default"
 * updates the Okta-provided default server IN PLACE — it can never be deleted or
 * recreated by this app — so validate surfaces a warning, not an error.
 */
export function nameSuggestsDefault(name: string): boolean {
  return name.trim().toLowerCase() === PROTECTED_SERVER_ID
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AuthServerSpec {
  sectionName: string
  /** Authorization server name — the logical identity deploy matches on. */
  name: string
  /** Optional description; sent on every deploy so clearing it converges. */
  description?: string
  /**
   * The token audiences — EXACTLY ONE is required (e.g. api://default). Modelled
   * as tags so the array shape survives round-trips; validate enforces length 1.
   */
  audiences: string[]
  /** Optional issuer mode — ORG_URL | CUSTOM_URL | DYNAMIC; Okta defaults it. */
  issuerMode?: string
  /** Desired lifecycle status — ACTIVE | INACTIVE (default ACTIVE). */
  status: string
}

/**
 * Shape of an authorization server returned by GET /authorizationServers. Carries
 * an index signature so a live server can be handed to helpers typed as
 * `Record<string, unknown>`. `issuer` and `credentials` are server-managed
 * readOnly fields — never sent back and never diffed.
 */
export interface LiveAuthServer {
  id?: string
  name?: string
  description?: string
  audiences?: string[]
  issuerMode?: string
  status?: string
  issuer?: string
  credentials?: unknown
  created?: string
  lastUpdated?: string
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/** Canvas list fields (tags) arrive as arrays, or comma/newline text. */
export function toAudienceList(value: unknown): string[] {
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

/** Each canvas item describes one Okta custom authorization server. */
export function extractAuthServerSpecs(canvas: CanvasSnapshot): AuthServerSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined

    const issuerMode =
      typeof fields.issuerMode === 'string' && fields.issuerMode.trim()
        ? fields.issuerMode.trim().toUpperCase()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      audiences: toAudienceList(fields.audiences),
      issuerMode,
      // status is an upper-case enum; normalise so a lower-case entry still
      // matches instead of failing as "invalid".
      status: typeof fields.status === 'string' && fields.status.trim()
        ? fields.status.trim().toUpperCase()
        : 'ACTIVE',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate authorization-server configurations against the Okta Authorization
 * Servers API. Static only — it never contacts Okta:
 *   - name is required, <= 40 chars, and unique within the canvas
 *   - audiences is required and must contain EXACTLY ONE entry
 *   - issuerMode (when set) is ORG_URL | CUSTOM_URL | DYNAMIC
 *   - status (when set) is ACTIVE | INACTIVE
 *
 * The Okta-provided default server (id === 'default') is PROTECTED — it may be
 * updated in place but never deleted/recreated. validate cannot see a live
 * server's id, so it WARNS when a name suggests the default server; the hard
 * delete guard lives in deploy / rollback.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAuthServerSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 40 chars, unique per canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Authorization server name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_AUTH_SERVER_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Authorization server name must be ${MAX_AUTH_SERVER_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate authorization server "${spec.name}" — each server may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)

      // The Okta-provided default server (id 'default', named 'default') is
      // protected: authoring it updates it in place but it can never be deleted
      // or recreated. Warn (not error) so the author knows the constraint.
      if (nameSuggestsDefault(spec.name)) {
        warnings.push({
          field: `${prefix}.name`,
          message:
            'This matches the Okta-provided default authorization server (id "default"). It will be updated IN PLACE — this app will never delete or recreate the default server.',
          code: 'default_server',
        })
      }
    }

    // audiences — required, and EXACTLY ONE entry
    if (spec.audiences.length === 0) {
      errors.push({
        field: `${prefix}.audiences`,
        message: 'An audience is required — provide exactly one, e.g. api://default',
        code: 'required',
      })
    } else if (spec.audiences.length !== 1) {
      errors.push({
        field: `${prefix}.audiences`,
        message: `An authorization server must have exactly one audience — found ${spec.audiences.length}`,
        code: 'invalid_audiences',
      })
    }

    // issuerMode — optional; when set, must be one of the supported modes
    if (spec.issuerMode && !(ISSUER_MODES as readonly string[]).includes(spec.issuerMode)) {
      errors.push({
        field: `${prefix}.issuerMode`,
        message: `Issuer mode must be one of: ${ISSUER_MODES.join(', ')}`,
        code: 'invalid_issuer_mode',
      })
    }

    // status — when set, must be ACTIVE or INACTIVE
    if (spec.status && !(AUTH_SERVER_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${AUTH_SERVER_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
