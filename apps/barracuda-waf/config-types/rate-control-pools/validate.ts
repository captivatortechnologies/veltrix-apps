import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  asArray,
  barracudaErrorMessage,
  readJsonArray,
  readNumber,
  readString,
  type BarracudaWaasClient,
} from '../../lib/barracudaWaf'

// --- Barracuda WAF-as-a-Service Rate Control Pools constraints ---------------
//
// A dedicated collection resource of the Application:
//   GET/POST              /applications/{appName}/rate_control/pools/          (list, create — trailing slash)
//   GET/PUT/PATCH/DELETE   /applications/{appName}/rate_control/pools/{name}/  (both paths carry a trailing slash)
// Every field (name, max_active_requests, max_unconfigured_clients,
// max_per_client_backlog, preferred_clients[].{name,ip_range,weight,enabled},
// urls[].{name,url,host,extended_match,priority}) is confirmed directly
// against the live API's request-body example (api.waas.barracudanetworks.com
// /v4/swagger/, "Add a Rate Control Pool"). Identity for reconciliation is the
// pool `name`, used directly in the URL (no separate server-assigned id, same
// convention as Traffic Rules/Header Allow-Deny rules).
//
// `preferred_clients` and `urls` are each an array of nested objects with no
// native canvas field type for a repeatable sub-object, so both are modeled
// as a JSON-array textarea escape hatch (same convention as IP Reputation's
// `exceptions_json`) rather than as separate nested config types. Barracuda's
// API also exposes them as independently addressable nested sub-resources
// (.../pools/{poolName}/preferred_clients/{clientName}/,
// .../pools/{poolName}/urls/{urlName}/), but this config type manages them
// via the pool's own embedded arrays — sent whole in the pool's PUT/POST body
// — keeping this app's scope at the pool level.

export interface PreferredClient {
  name: string
  ipRange: string
  weight: number
  enabled: boolean
}

export interface PoolUrl {
  name: string
  url: string
  host: string
  extendedMatch: string
  priority: number
}

export interface RateControlPoolSpec {
  sectionName: string
  name: string
  maxActiveRequests: number
  maxUnconfiguredClients: number
  maxPerClientBacklog: number
  preferredClients: PreferredClient[]
  preferredClientsError: string | null
  preferredClientsInvalid: number[]
  urls: PoolUrl[]
  urlsError: string | null
  urlsInvalid: number[]
}

/**
 * Parse+type-check the `preferred_clients_json` textarea's items. Only
 * `name` is required; `ip_range`/`weight`/`enabled` are optional but, when
 * present, must carry the right type — a malformed entry (missing name, or a
 * present field of the wrong type) is reported by index rather than silently
 * dropped or coerced.
 */
function readPreferredClients(raw: unknown[]): { clients: PreferredClient[]; invalid: number[] } {
  const clients: PreferredClient[] = []
  const invalid: number[] = []
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      invalid.push(i)
      return
    }
    const item = entry as Record<string, unknown>
    const name = readString(item.name)
    const malformed =
      !name ||
      (item.ip_range !== undefined && typeof item.ip_range !== 'string') ||
      (item.weight !== undefined && typeof item.weight !== 'number') ||
      (item.enabled !== undefined && typeof item.enabled !== 'boolean')
    if (malformed) {
      invalid.push(i)
      return
    }
    clients.push({
      name,
      ipRange: readString(item.ip_range),
      weight: readNumber(item.weight, 100),
      enabled: typeof item.enabled === 'boolean' ? item.enabled : false,
    })
  })
  return { clients, invalid }
}

/**
 * Parse+type-check the `urls_json` textarea's items. `name`/`url` are
 * required; `host`/`extended_match`/`priority` are optional but, when
 * present, must carry the right type — a malformed entry is reported by
 * index rather than silently dropped or coerced.
 */
function readPoolUrls(raw: unknown[]): { urls: PoolUrl[]; invalid: number[] } {
  const urls: PoolUrl[] = []
  const invalid: number[] = []
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      invalid.push(i)
      return
    }
    const item = entry as Record<string, unknown>
    const name = readString(item.name)
    const url = readString(item.url)
    const malformed =
      !name ||
      !url ||
      (item.host !== undefined && typeof item.host !== 'string') ||
      (item.extended_match !== undefined && typeof item.extended_match !== 'string') ||
      (item.priority !== undefined && typeof item.priority !== 'number')
    if (malformed) {
      invalid.push(i)
      return
    }
    urls.push({
      name,
      url,
      host: readString(item.host) || '*',
      extendedMatch: readString(item.extended_match) || '*',
      priority: readNumber(item.priority, 1),
    })
  })
  return { urls, invalid }
}

/** Each canvas item describes one rate-control pool. */
export function extractRateControlPoolSpecs(canvas: CanvasSnapshot): RateControlPoolSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const { items: rawPreferred, error: preferredClientsError } = readJsonArray<unknown>(fields.preferred_clients_json)
    const { items: rawUrls, error: urlsError } = readJsonArray<unknown>(fields.urls_json)
    const { clients, invalid: preferredClientsInvalid } = readPreferredClients(rawPreferred)
    const { urls, invalid: urlsInvalid } = readPoolUrls(rawUrls)

    return {
      sectionName: section.name,
      name: readString(fields.name),
      maxActiveRequests: readNumber(fields.max_active_requests, 100),
      maxUnconfiguredClients: readNumber(fields.max_unconfigured_clients, 100),
      maxPerClientBacklog: readNumber(fields.max_per_client_backlog, 32),
      preferredClients: clients,
      preferredClientsError,
      preferredClientsInvalid,
      urls,
      urlsError,
      urlsInvalid,
    }
  })
}

/** The pool's identity key — its name. */
export function rateControlPoolKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Shape of a pool returned by GET /applications/{appName}/rate_control/pools/. */
export interface LiveRateControlPool {
  name?: string
  max_active_requests?: number
  max_unconfigured_clients?: number
  max_per_client_backlog?: number
  preferred_clients?: Array<{ name?: string; ip_range?: string; weight?: number; enabled?: boolean }>
  urls?: Array<{ name?: string; url?: string; host?: string; extended_match?: string; priority?: number }>
}

/** Build the POST/PUT request body for a declared rate-control pool. */
export function buildRateControlPoolBody(spec: RateControlPoolSpec): LiveRateControlPool {
  return {
    name: spec.name,
    max_active_requests: spec.maxActiveRequests,
    max_unconfigured_clients: spec.maxUnconfiguredClients,
    max_per_client_backlog: spec.maxPerClientBacklog,
    preferred_clients: spec.preferredClients.map((c) => ({ name: c.name, ip_range: c.ipRange, weight: c.weight, enabled: c.enabled })),
    urls: spec.urls.map((u) => ({ name: u.name, url: u.url, host: u.host, extended_match: u.extendedMatch, priority: u.priority })),
  }
}

/** List every rate-control pool on the Application (follows pagination); throws on a non-OK response. */
export async function listRateControlPools(client: BarracudaWaasClient, appName: string): Promise<LiveRateControlPool[]> {
  const res = await client.listAll<LiveRateControlPool>(`${client.appPath(appName)}/rate_control/pools/`)
  if (!res.ok) throw new Error(`Failed to list Rate Control Pools: ${barracudaErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  return res.items.length ? res.items : asArray<LiveRateControlPool>(res.body)
}

/** Path to a single rate-control pool by name (trailing slash — see module doc). */
export function rateControlPoolPath(client: BarracudaWaasClient, appName: string, name: string): string {
  return `${client.appPath(appName)}/rate_control/pools/${encodeURIComponent(name)}/`
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Rate Control Pools: the name is required and unique across the
 * canvas; the three request-rate limits must be non-negative integers; the
 * preferred_clients_json/urls_json textareas must parse as JSON arrays whose
 * entries carry the expected fields with the right types.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRateControlPoolSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = rateControlPoolKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate pool name "${spec.name}" — each pool may only be declared once`, code: 'duplicate_name' })
      }
      seen.add(key)
    }

    if (!Number.isInteger(spec.maxActiveRequests) || spec.maxActiveRequests < 0) {
      errors.push({ field: `${prefix}.max_active_requests`, message: 'Max Active Requests must be a non-negative integer', code: 'invalid_number' })
    }
    if (!Number.isInteger(spec.maxUnconfiguredClients) || spec.maxUnconfiguredClients < 0) {
      errors.push({ field: `${prefix}.max_unconfigured_clients`, message: 'Max Unconfigured Clients must be a non-negative integer', code: 'invalid_number' })
    }
    if (!Number.isInteger(spec.maxPerClientBacklog) || spec.maxPerClientBacklog < 0) {
      errors.push({ field: `${prefix}.max_per_client_backlog`, message: 'Max Per-Client Backlog must be a non-negative integer', code: 'invalid_number' })
    }

    if (spec.preferredClientsError) {
      errors.push({ field: `${prefix}.preferred_clients_json`, message: `Preferred Clients ${spec.preferredClientsError}`, code: 'invalid_json' })
    } else if (spec.preferredClientsInvalid.length > 0) {
      errors.push({
        field: `${prefix}.preferred_clients_json`,
        message: `Preferred Clients entry at index ${spec.preferredClientsInvalid.join(', ')} is malformed — each entry needs a "name" string, and "ip_range" (string)/"weight" (number)/"enabled" (boolean) when present`,
        code: 'malformed_entry',
      })
    }

    if (spec.urlsError) {
      errors.push({ field: `${prefix}.urls_json`, message: `URLs ${spec.urlsError}`, code: 'invalid_json' })
    } else if (spec.urlsInvalid.length > 0) {
      errors.push({
        field: `${prefix}.urls_json`,
        message: `URLs entry at index ${spec.urlsInvalid.join(', ')} is malformed — each entry needs "name"/"url" strings, and "host"/"extended_match" (string)/"priority" (number) when present`,
        code: 'malformed_entry',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
