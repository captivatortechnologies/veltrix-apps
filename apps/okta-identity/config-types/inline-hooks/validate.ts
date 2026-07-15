import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Inline Hooks API constraints ---------------------------------------

/**
 * The inline hook types Okta supports. An inline hook's logical identity is the
 * (name, type) PAIR — the same name may exist once per type — so deploy lists
 * hooks (optionally filtered by ?type=), matches on (name, type), and PUTs
 * (found) or POSTs (missing); Okta has no upsert.
 */
export const INLINE_HOOK_TYPES = [
  'com.okta.oauth2.tokens.transform',
  'com.okta.saml.tokens.transform',
  'com.okta.import.transform',
  'com.okta.telephony.provider',
  'com.okta.user.credential.password.import',
  'com.okta.user.pre-registration',
] as const
export type InlineHookType = (typeof INLINE_HOOK_TYPES)[number]

/** The channel transport kinds — HTTP (header auth) or OAUTH (client credentials). */
export const CHANNEL_TYPES = ['HTTP', 'OAUTH'] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

/** A hook's lifecycle state — changed via the lifecycle endpoints, not PUT. */
export const HOOK_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** Reasonable cap on the hook name (Okta console limit). */
export const MAX_HOOK_NAME_LENGTH = 255

/** Okta caps the number of inline hooks per org. */
export const MAX_INLINE_HOOKS_PER_ORG = 50

/** Body/channel version Okta expects for an inline hook. */
export const HOOK_VERSION = '1.0.0'
export const CHANNEL_VERSION = '1.0.0'

/** Default HTTP auth header name when the field is left blank. */
export const DEFAULT_AUTH_HEADER_KEY = 'Authorization'

/**
 * Channel-config keys holding a WRITE-ONLY secret that Okta never returns on GET.
 * They are excluded from drift comparison so an unreadable secret can never read
 * as drift. The HTTP secret lives at channel.config.authScheme.value and is
 * modeled as the dedicated `authHeaderValue` password field (never in configJson,
 * so never drift-compared); the OAUTH secret is `clientSecret` inside configJson.
 */
export const SECRET_CONFIG_KEYS = ['clientSecret'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface InlineHookSpec {
  sectionName: string
  /** Hook name — half of the (name, type) logical identity. */
  name: string
  /** Hook type — the Okta inline hook type; the other half of the identity. */
  type: string
  /** Desired lifecycle status — ACTIVE | INACTIVE (applied via lifecycle endpoints). */
  status: string
  /** Channel transport — HTTP | OAUTH. */
  channelType: string
  /** External endpoint URI (https) the hook calls. */
  uri: string
  /** HTTP auth header name (defaults to Authorization at build time). */
  authHeaderKey: string
  /**
   * HTTP auth header value — the WRITE-ONLY shared secret (channel.config.authScheme.value).
   * Okta never returns it on GET, so it is never drift-checked; leave it blank on a
   * re-deploy to keep the stored value (a blank value is omitted from the PUT body).
   */
  authHeaderValue?: string
  /**
   * Raw JSON string of extra channel.config fields, merged into the body. For
   * OAUTH this carries clientId / clientSecret / tokenUrl / scope / authType;
   * `clientSecret` is a write-only secret and is excluded from drift.
   */
  configJson?: string
}

/** Shape of the channel object on a live inline hook. */
export interface LiveChannel {
  type?: string
  version?: string
  config?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Shape of an inline hook returned by GET /inlineHooks. Carries an index
 * signature so a live hook can be handed to helpers typed as `Record<string, unknown>`.
 */
export interface LiveInlineHook {
  id?: string
  name?: string
  type?: string
  version?: string
  status?: string
  system?: boolean
  created?: string
  lastUpdated?: string
  channel?: LiveChannel
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/** True when `type` is a supported inline hook type (case-insensitive). */
export function isInlineHookType(type: string): boolean {
  const lower = type.trim().toLowerCase()
  return (INLINE_HOOK_TYPES as readonly string[]).some((t) => t.toLowerCase() === lower)
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not a
 * JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the channel config).
 */
export function parseChannelConfig(raw: string): Record<string, unknown> | null {
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

/** Each canvas item describes one Okta inline hook. */
export function extractInlineHookSpecs(canvas: CanvasSnapshot): InlineHookSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const configJson =
      typeof fields.configJson === 'string' && fields.configJson.trim()
        ? fields.configJson.trim()
        : undefined

    const authHeaderValue =
      typeof fields.authHeaderValue === 'string' && fields.authHeaderValue.trim()
        ? fields.authHeaderValue.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      // Hook types are lower-case dotted identifiers — normalise to lower so a
      // mixed-case entry still matches instead of failing as "invalid".
      type: typeof fields.type === 'string' ? fields.type.trim().toLowerCase() : '',
      // Statuses/channel kinds are upper-case enums; normalise so a lower-case
      // entry still matches.
      status: typeof fields.status === 'string' && fields.status.trim() ? fields.status.trim().toUpperCase() : 'ACTIVE',
      channelType:
        typeof fields.channelType === 'string' && fields.channelType.trim()
          ? fields.channelType.trim().toUpperCase()
          : 'HTTP',
      uri: typeof fields.uri === 'string' ? fields.uri.trim() : '',
      authHeaderKey: typeof fields.authHeaderKey === 'string' ? fields.authHeaderKey.trim() : '',
      authHeaderValue,
      configJson,
    }
  })
}

/** True when the URI is an https:// endpoint (Okta requires TLS for hook targets). */
export function isHttpsUri(uri: string): boolean {
  return /^https:\/\/\S+/i.test(uri.trim())
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate inline-hook configurations against the Okta Inline Hooks API. Static
 * only — it never contacts Okta:
 *   - name is required, <= 255 chars
 *   - type is required and one of the supported inline hook types
 *   - the (name, type) PAIR — a hook's logical identity — is unique per canvas
 *   - channelType (when set) is HTTP | OAUTH
 *   - uri is required and must be an https:// endpoint
 *   - status (when set) is ACTIVE | INACTIVE
 *   - configJson (when set) parses to a JSON OBJECT
 *   - no more than 50 hooks are declared (Okta's per-org cap)
 *
 * There are no protected/system inline hooks to reject. The write-only secret
 * (authHeaderValue / clientSecret) is never required here — it is left blank on a
 * re-deploy to keep the stored value — but a first deploy needs it, so its absence
 * for a new hook is surfaced as a warning, not an error.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractInlineHookSpecs(ctx.canvas)

  if (specs.length > MAX_INLINE_HOOKS_PER_ORG) {
    errors.push({
      field: 'sections',
      message: `Okta allows at most ${MAX_INLINE_HOOKS_PER_ORG} inline hooks per org, but ${specs.length} are declared`,
      code: 'org_cap',
    })
  }

  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required and <= 255 chars
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Hook name is required', code: 'required' })
    } else if (spec.name.length > MAX_HOOK_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Hook name must be ${MAX_HOOK_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // type — required and in the supported enum
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Hook type is required', code: 'required' })
    } else if (!isInlineHookType(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Hook type must be one of: ${INLINE_HOOK_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // channelType — when set, must be HTTP or OAUTH
    if (spec.channelType && !(CHANNEL_TYPES as readonly string[]).includes(spec.channelType)) {
      errors.push({
        field: `${prefix}.channelType`,
        message: `Channel type must be one of: ${CHANNEL_TYPES.join(', ')}`,
        code: 'invalid_channel_type',
      })
    }

    // uri — required and must be an https endpoint (Okta rejects plain HTTP)
    if (!spec.uri) {
      errors.push({ field: `${prefix}.uri`, message: 'Channel URI is required', code: 'required' })
    } else if (!isHttpsUri(spec.uri)) {
      errors.push({
        field: `${prefix}.uri`,
        message: 'Channel URI must be an https:// endpoint — Okta rejects non-TLS inline hook targets',
        code: 'invalid_uri',
      })
    }

    // status — when set, must be ACTIVE or INACTIVE
    if (spec.status && !(HOOK_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${HOOK_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // configJson — when present it must parse to a JSON object.
    const config = spec.configJson ? parseChannelConfig(spec.configJson) : {}
    if (spec.configJson && config === null) {
      errors.push({
        field: `${prefix}.configJson`,
        message:
          'Channel config must be a valid JSON object, e.g. {"clientId":"…","clientSecret":"…","tokenUrl":"https://…","scope":"…","authType":"client_secret_post"}',
        code: 'invalid_config',
      })
    }

    // OAUTH channels need client credentials, which live in configJson. Warn (not
    // error) when they are missing — the write-only secret may be intentionally
    // omitted on a re-deploy, but a brand-new OAUTH hook cannot work without them.
    if (spec.channelType === 'OAUTH') {
      const oauth = config && config !== null ? config : {}
      if (!spec.configJson || (oauth && oauth.clientId === undefined)) {
        warnings.push({
          field: `${prefix}.configJson`,
          message:
            'An OAUTH channel needs clientId / clientSecret / tokenUrl in the channel config (JSON). Provide them on the first deploy; clientSecret is write-only and may be omitted later to keep the stored value.',
          code: 'oauth_credentials_missing',
        })
      }
    }

    // HTTP secret — write-only. Absent for a new hook means it was never set; flag
    // it as a warning so an author is not surprised when Okta rejects the create.
    if (spec.channelType === 'HTTP' && !spec.authHeaderValue) {
      warnings.push({
        field: `${prefix}.authHeaderValue`,
        message:
          'No HTTP auth header value provided. It is write-only (never returned by Okta) — required on the first deploy, but leave it blank on a re-deploy to keep the existing secret.',
        code: 'secret_missing',
      })
    }

    // (name, type) PAIR is the hook's logical identity — dedupe on it. A JSON-array
    // key keeps the two halves unambiguous. Matched on the normalised (trimmed /
    // lower-cased) values to agree with the live (name, type) match in deploy.
    if (spec.name && spec.type) {
      const key = JSON.stringify([spec.name.toLowerCase(), spec.type])
      if (seenPairs.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate inline hook "${spec.type}:${spec.name}" — each (name, type) pair may only be declared once per canvas`,
          code: 'duplicate_hook',
        })
      }
      seenPairs.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
