// =============================================================================
// Splunk Cloud Platform REST API client (stack management port 8089).
//
// ACS is this app's primary API, but ACS CANNOT MANAGE IDENTITY — it covers
// indexes, HEC, IP allow lists, outbound ports, limits, maintenance windows,
// private apps and tokens, and nothing else. Roles are therefore managed the
// same way Splunk Enterprise manages them: the Splunk REST API endpoint
// /services/authorization/roles — only here it is reached on the stack's own
// management port:
//
//     https://<stack>.splunkcloud.com:8089/services/authorization/roles
//
// Shipping roles inside a private app is not an alternative: authorize.conf is
// on Splunk Cloud's AppInspect deny list (see CLOUD_DENIED_CONFS in
// lib/splunkPackage.ts), so a package containing it fails vetting.
//
// TWO PREREQUISITES, both outside this app's control. Every failure path below
// names them, because a bare ECONNREFUSED here is almost always one of them:
//
//   1. Splunk Support must OPEN port 8089 for the stack. It is CLOSED by
//      default and there is no self-service way to open it.
//   2. The caller's egress IP must be on the stack's `search-api` IP allow
//      list — which this very app manages, via its `ip-allowlists`
//      configuration type.
//
// Authentication is a Splunk authentication token (Authorization: Bearer),
// created in Splunk Web under Settings > Tokens. It is NOT interchangeable
// with the ACS stack token. Free-trial stacks cannot use the REST API at all.
//
// Ref: https://help.splunk.com/en/splunk-cloud-platform/leverage-rest-apis/rest-api-tutorials/9.3.2408/rest-api-tutorials/access-requirements-and-limitations-for-the-splunk-cloud-platform-rest-api
// =============================================================================

import type { ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** Splunk Cloud exposes the REST API only on the management port. */
export const SPLUNK_CLOUD_MANAGEMENT_PORT = 8089

/** The two things that must be true before the REST API answers at all. */
export const REST_PREREQUISITES =
  'The Splunk Cloud REST API requires BOTH: (1) Splunk Support must open management port ' +
  `${SPLUNK_CLOUD_MANAGEMENT_PORT} for this stack — it is closed by default; and (2) the caller's IP ` +
  'must be on the stack\'s "search-api" IP allow list — manage it with this app\'s "IP Allow Lists" ' +
  'configuration type. Free-trial stacks cannot use the REST API.'

/** Message used whenever the credential carries no Splunk authentication token. */
export const REST_TOKEN_MISSING =
  'No Splunk authentication token — store a Splunk Cloud REST token (Splunk Web > Settings > Tokens) ' +
  'in the credential\'s "API token" field. This is NOT the ACS stack token: ACS cannot manage roles, ' +
  'so roles go through the stack REST API instead.'

export interface RestSettings {
  timeoutMs: number
}

/** Read the app settings that drive REST access (shares the app's request timeout). */
export function readRestSettings(settings: Record<string, unknown>): RestSettings {
  const raw = settings.request_timeout_seconds
  const seconds = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 30
  return { timeoutMs: seconds * 1000 }
}

/**
 * Resolve the stack's REST hostname from a component hostname.
 * Components are registered as "mystack", "mystack.splunkcloud.com" or a full
 * URL; ACS wants the bare stack name, but REST wants the FQDN — a bare stack
 * name is expanded to <stack>.splunkcloud.com.
 */
export function resolveStackHost(hostname: string): string {
  let host = (hostname ?? '').trim()
  host = host.replace(/^https?:\/\//i, '')
  host = host.split('/')[0] ?? host
  host = host.split(':')[0] ?? host
  if (!host) return ''
  // Already qualified (splunkcloud.com, splunkcloudgc.com, a custom CNAME…).
  return host.includes('.') ? host : `${host}.splunkcloud.com`
}

/**
 * Base URL for the stack's REST API. The port is pinned to 8089: it is the only
 * port Splunk Cloud serves splunkd on, and a component's `port` normally records
 * the web/UI port, which does not answer REST.
 */
export function buildRestUrl(component: ComponentRef): string {
  return `https://${resolveStackHost(component.hostname)}:${SPLUNK_CLOUD_MANAGEMENT_PORT}`
}

/** Bearer auth from the credential's API token field. Null when absent. */
export function resolveRestToken(credential: CredentialRef | null): string | null {
  const token = credential?.apiToken?.trim()
  return token ? token : null
}

export function buildAuthHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export interface SplunkRestOptions {
  method: string
  headers: Record<string, string>
  body?: string
  timeoutMs?: number
}

/**
 * Perform a request against the stack's REST API, throwing on non-2xx.
 *
 * Network-level failures (port closed, IP not allow-listed, DNS) surface as an
 * opaque fetch error, so they are rewritten to name the two prerequisites — the
 * user must never be left staring at a bare "fetch failed".
 */
export async function splunkRestRequest(url: string, options: SplunkRestOptions): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)

  let res: Response
  try {
    res = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    })
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? 'the request timed out'
        : `the connection failed (${error instanceof Error ? error.message : 'unknown error'})`
    throw new Error(
      `Cannot reach the Splunk Cloud REST API at ${url} — ${reason}. ${REST_PREREQUISITES}`,
    )
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401) {
      throw new Error(
        `Splunk REST API rejected the token (401) at ${url} — the Splunk authentication token is ` +
          'invalid or expired. Note it is NOT the ACS stack token.',
      )
    }
    if (res.status === 403) {
      throw new Error(
        `Splunk REST API denied the request (403) at ${url} — the token's user lacks the required ` +
          'capability (role management needs edit_roles / edit_roles_grantable; sc_admin has it).',
      )
    }
    throw new Error(`Splunk REST API ${res.status} at ${url}: ${extractRestMessage(text) || text}`)
  }

  return res.text()
}

/** Pull the human-readable message out of a Splunk REST JSON/XML error body. */
export function extractRestMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ text?: string }> }
    const text = parsed?.messages?.[0]?.text
    if (typeof text === 'string' && text.trim()) return text.trim()
  } catch {
    const match = /<msg[^>]*>([\s\S]*?)<\/msg>/i.exec(body)
    if (match?.[1]) return match[1].trim()
  }
  return ''
}

/**
 * Encode a Splunk REST payload as application/x-www-form-urlencoded.
 * Array values are appended once per element — Splunk's multi-value convention
 * for parameters like `capabilities`, `imported_roles` and `srchIndexesAllowed`.
 * An EMPTY STRING is sent as-is (that is how Splunk clears a field); undefined
 * and null are skipped.
 */
export function toFormBody(
  params: Record<string, string | number | boolean | string[] | undefined | null>,
): string {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) form.append(key, item)
    } else {
      form.append(key, String(value))
    }
  }
  return form.toString()
}

/** POST form data to a REST endpoint. */
export async function postForm(
  baseUrl: string,
  auth: Record<string, string>,
  entityPath: string,
  params: Record<string, string | number | boolean | string[] | undefined | null>,
  timeoutMs?: number,
): Promise<string> {
  return splunkRestRequest(`${baseUrl}${entityPath}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: toFormBody(params),
    timeoutMs,
  })
}

/** DELETE a REST entity. */
export async function deleteEntity(
  baseUrl: string,
  auth: Record<string, string>,
  entityPath: string,
  timeoutMs?: number,
): Promise<string> {
  return splunkRestRequest(`${baseUrl}${entityPath}`, {
    method: 'DELETE',
    headers: auth,
    timeoutMs,
  })
}

/**
 * GET a single REST entity and return its `entry[0].content`, or null when the
 * entity does not exist (404).
 *
 * Unlike a missing entity, a CONNECTION failure or an auth failure is a real
 * problem and is re-thrown — swallowing it would let a deploy silently "create"
 * roles it never reached, and would hide exactly the two prerequisites above.
 */
export async function getEntityContent(
  baseUrl: string,
  auth: Record<string, string>,
  entityPath: string,
  timeoutMs?: number,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await splunkRestRequest(`${baseUrl}${entityPath}?output_mode=json`, {
      method: 'GET',
      headers: auth,
      timeoutMs,
    })
    const data = JSON.parse(res) as { entry?: Array<{ content?: Record<string, unknown> }> }
    return data?.entry?.[0]?.content ?? null
  } catch (error) {
    if (error instanceof Error && /Splunk REST API 404\b/.test(error.message)) return null
    throw error
  }
}
