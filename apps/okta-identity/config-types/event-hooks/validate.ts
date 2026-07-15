import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Event Hooks API constraints ----------------------------------------

/** An event hook's lifecycle state — changed via the lifecycle endpoints, not PUT. */
export const EVENT_HOOK_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** Event-hook display name cap. */
export const MAX_EVENT_HOOK_NAME_LENGTH = 255

/** Default HTTP header used to carry the write-only auth secret to the endpoint. */
export const DEFAULT_AUTH_HEADER_KEY = 'Authorization'

/**
 * Plausible-Okta-event-type shape, e.g. `user.lifecycle.create`,
 * `application.user_membership.add`. Used only for a soft WARNING — Okta owns the
 * authoritative catalog, so a mismatch is flagged, never rejected.
 */
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface EventHookSpec {
  sectionName: string
  /** Event-hook name — the logical identity deploy matches on. */
  name: string
  /** Desired lifecycle status — ACTIVE | INACTIVE. */
  status: string
  /** Subscribed Okta event type names (events.items). */
  eventItems: string[]
  /** External HTTPS endpoint Okta POSTs the events to (channel.config.uri). */
  uri: string
  /** Auth header name Okta sends (channel.config.authScheme.key). Defaults to Authorization. */
  authHeaderKey: string
  /**
   * WRITE-ONLY secret — the auth header value (channel.config.authScheme.value).
   * Okta NEVER returns it on GET, so it is re-asserted on every deploy and is
   * excluded from drift. Preserved verbatim (a token may contain punctuation).
   */
  authHeaderValue?: string
  /** Raw JSON string of extra static channel headers ([{key,value}]). Optional. */
  headersJson?: string
}

/** A single extra channel header (channel.config.headers[]). */
export interface HookHeader {
  key: string
  value: string
}

/**
 * Shape of an event hook returned by GET /eventHooks. The authScheme.value is
 * NEVER present on a read (write-only), so no field models it. Index signature so
 * a live hook can be handed to helpers typed as `Record<string, unknown>`.
 */
export interface LiveEventHook {
  id?: string
  name?: string
  status?: string
  verificationStatus?: string
  events?: { type?: string; items?: string[] }
  channel?: {
    type?: string
    version?: string
    config?: {
      uri?: string
      headers?: Array<{ key?: string; value?: string }>
      authScheme?: { type?: string; key?: string; value?: string }
    }
  }
  created?: string
  lastUpdated?: string
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/** Canvas list fields (tags) arrive as arrays, or comma/newline text. */
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
 * Preserve a secret's EXACT characters (a token may contain spaces or
 * punctuation), but treat a whitespace-only value as blank (undefined).
 */
export function preserveSecret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim().length > 0 ? value : undefined
}

/**
 * Parse a raw JSON string, returning the ARRAY or null when the string is not a
 * JSON array. Elements are NOT validated here — callers check each is an object
 * with a non-empty `key`. Shared by validate (reject) and deploy (build body).
 */
export function parseHeadersArray(raw: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed : null
}

/** Map a parsed headers array to well-formed {key,value} entries (drops junk). */
export function normalizeHeaders(parsed: unknown[]): HookHeader[] {
  const out: HookHeader[] = []
  for (const el of parsed) {
    if (el && typeof el === 'object' && !Array.isArray(el)) {
      const key = (el as Record<string, unknown>).key
      const value = (el as Record<string, unknown>).value
      if (typeof key === 'string' && key.trim()) {
        out.push({
          key: key.trim(),
          value: typeof value === 'string' ? value : value == null ? '' : String(value),
        })
      }
    }
  }
  return out
}

/** Each canvas item describes one Okta event hook. */
export function extractEventHookSpecs(canvas: CanvasSnapshot): EventHookSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const headersJson =
      typeof fields.headersJson === 'string' && fields.headersJson.trim()
        ? fields.headersJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      // Statuses are upper-case enums; normalise so a lower-case entry still
      // matches instead of failing as "invalid".
      status:
        typeof fields.status === 'string' && fields.status.trim()
          ? fields.status.trim().toUpperCase()
          : 'ACTIVE',
      eventItems: toStringList(fields.eventItems),
      uri: typeof fields.uri === 'string' ? fields.uri.trim() : '',
      authHeaderKey:
        typeof fields.authHeaderKey === 'string' && fields.authHeaderKey.trim()
          ? fields.authHeaderKey.trim()
          : DEFAULT_AUTH_HEADER_KEY,
      authHeaderValue: preserveSecret(fields.authHeaderValue),
      headersJson,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate event-hook configurations against the Okta Event Hooks API. Static
 * only — it never contacts Okta:
 *   - name is required, <= 255 chars, and unique within the canvas
 *   - at least one subscribed event type is required (each flagged if it does
 *     not look like an Okta event type — a WARNING, never an error)
 *   - the channel URI is required and must be HTTPS (Okta rejects plain HTTP)
 *   - the auth header value (the WRITE-ONLY secret) is required and re-asserted
 *     on every deploy — Okta never returns it, so it cannot be drift-checked
 *   - headersJson, when set, parses to a JSON ARRAY of {key,value} objects
 *
 * Event hooks have no protected/system objects (unlike network zones), so there
 * is no reserved-name guard.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractEventHookSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Event hook name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_EVENT_HOOK_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Event hook name must be ${MAX_EVENT_HOOK_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate event hook "${spec.name}" — each hook may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // status — when set, must be ACTIVE or INACTIVE
    if (spec.status && !(EVENT_HOOK_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${EVENT_HOOK_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // events — at least one subscribed event type is required
    if (spec.eventItems.length === 0) {
      errors.push({
        field: `${prefix}.eventItems`,
        message: 'Subscribe to at least one Okta event type, e.g. user.lifecycle.create',
        code: 'required',
      })
    } else {
      for (const evt of spec.eventItems) {
        if (!EVENT_TYPE_PATTERN.test(evt)) {
          warnings.push({
            field: `${prefix}.eventItems`,
            message: `"${evt}" does not look like an Okta event type (expected a dotted name such as user.lifecycle.create) — double-check it against Okta's event catalog`,
            code: 'suspicious_event_type',
          })
        }
      }
    }

    // uri — required and must be HTTPS (Okta will not accept a plain-HTTP endpoint)
    if (!spec.uri) {
      errors.push({ field: `${prefix}.uri`, message: 'Channel URI is required', code: 'required' })
    } else if (!/^https:\/\//i.test(spec.uri)) {
      errors.push({
        field: `${prefix}.uri`,
        message: 'Channel URI must be an HTTPS URL — Okta rejects plain-HTTP event-hook endpoints',
        code: 'invalid_uri',
      })
    }

    // authHeaderValue — the WRITE-ONLY secret; required and re-asserted every deploy
    if (!spec.authHeaderValue) {
      errors.push({
        field: `${prefix}.authHeaderValue`,
        message:
          'Auth header value is required — it is a write-only secret Okta never returns, so it must be re-entered and is re-sent on every deploy',
        code: 'required',
      })
    }

    // headersJson — when present, must parse to a JSON array of {key,value} objects
    if (spec.headersJson) {
      const parsed = parseHeadersArray(spec.headersJson)
      if (parsed === null) {
        errors.push({
          field: `${prefix}.headersJson`,
          message:
            'Extra headers must be a JSON array of {"key":"...","value":"..."} objects, e.g. [{"key":"X-Trace","value":"1"}]',
          code: 'invalid_headers',
        })
      } else {
        const bad = parsed.some(
          (el) =>
            !el ||
            typeof el !== 'object' ||
            Array.isArray(el) ||
            typeof (el as Record<string, unknown>).key !== 'string' ||
            !((el as Record<string, unknown>).key as string).trim(),
        )
        if (bad) {
          errors.push({
            field: `${prefix}.headersJson`,
            message: 'Every extra header must be an object with a non-empty string "key"',
            code: 'invalid_headers',
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
