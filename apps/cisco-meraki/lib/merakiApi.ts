// =============================================================================
// Cisco Meraki Dashboard API v1 client.
//
// Base URL is FIXED for every organization at https://api.meraki.com/api/v1 —
// Meraki has no per-tenant API subdomain, so there is no host to resolve, only
// the Dashboard API key. Auth is a single header:
//
//   Authorization: Bearer <api-key>
//
// (v1 supports Bearer Auth via the standard Authorization header; the older
// `X-Cisco-Meraki-API-Key` header is a v0 legacy scheme and is not used here.)
//
// Rate limiting is enforced per organization (10 requests/second, with a burst
// allowance of +10 in the first second — up to 30 in a 2-second window) and per
// source IP (100 requests/second). Exceeding either returns HTTP 429 with a
// `Retry-After` header (seconds to wait). This client honors it with a bounded
// retry.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout
// and never throws on an HTTP error status from `request()` — callers inspect
// `status`/`ok` so they can tell a 404 (e.g. network not found / not an MX
// network) from a genuine failure.
//
// Docs:
//   https://developer.cisco.com/meraki/api-v1/overview/
//   https://developer.cisco.com/meraki/api-v1/authorization/
//   https://developer.cisco.com/meraki/api-v1/rate-limit/
//   https://developer.cisco.com/meraki/api-v1/get-organizations/
//   https://developer.cisco.com/meraki/api-v1/get-network-appliance-firewall-l-3-firewall-rules/
//   https://developer.cisco.com/meraki/api-v1/update-network-appliance-firewall-l-3-firewall-rules/
//   https://developer.cisco.com/meraki/api-v1/get-network-appliance-firewall-l-7-firewall-rules/
//   https://developer.cisco.com/meraki/api-v1/update-network-appliance-firewall-l-7-firewall-rules/
//   https://developer.cisco.com/meraki/api-v1/get-network-group-policies/
//   https://developer.cisco.com/meraki/api-v1/create-network-group-policy/
//   https://developer.cisco.com/meraki/api-v1/update-network-group-policy/
//   https://developer.cisco.com/meraki/api-v1/delete-network-group-policy/
//   https://developer.cisco.com/meraki/api-v1/get-network-appliance-vlans/
//   https://developer.cisco.com/meraki/api-v1/get-network-appliance-vlans-settings/
//   https://developer.cisco.com/meraki/api-v1/update-network-appliance-vlans-settings/
//   https://developer.cisco.com/meraki/api-v1/create-network-appliance-vlan/
//   https://developer.cisco.com/meraki/api-v1/update-network-appliance-vlan/
//   https://developer.cisco.com/meraki/api-v1/delete-network-appliance-vlan/
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import type { MerakiL3FirewallRule } from '../config-types/l3-firewall-rules/_shared'
import type { MerakiL7FirewallRule } from '../config-types/l7-firewall-rules/_shared'
import type { MerakiGroupPolicy } from '../config-types/group-policies/_shared'
import type { MerakiVlan } from '../config-types/appliance-vlans/_shared'

export const BASE_URL = 'https://api.meraki.com/api/v1'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 3
/** Fallback backoff when a 429 carries no (or an unusable) Retry-After header. */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 2_000
/** Never wait longer than this for a single Retry-After — fail fast instead. */
const MAX_RATE_LIMIT_WAIT_MS = 15_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const MISSING_CREDENTIAL_MESSAGE =
  'No Meraki Dashboard API key available — generate one in the Meraki dashboard ' +
  '(Organization > Settings > Dashboard API access, then your admin profile\'s ' +
  '"Generate new API key") and store it in the credential\'s "API token" field. ' +
  'The app sends it as "Authorization: Bearer <key>" to https://api.meraki.com/api/v1.'

export interface MerakiSettings {
  timeoutMs: number
}

export function readMerakiSettings(settings: Record<string, unknown>): MerakiSettings {
  const rawTimeout = settings?.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

/** Extract the Meraki Dashboard API key from a Veltrix credential ("API token" or "password"). */
export function resolveMerakiApiKey(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const key = (credential.apiToken ?? credential.password ?? '').trim()
  return key.length > 0 ? key : null
}

export interface MerakiResponse {
  status: number
  ok: boolean
  body: string
}

export type MerakiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class MerakiClient {
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(opts: { apiKey: string; timeoutMs: number }) {
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs
  }

  /**
   * One request against the Meraki Dashboard API. `path` is relative to
   * BASE_URL, e.g. `/organizations` or
   * `/networks/{networkId}/appliance/firewall/l3FirewallRules`. Retries a 429
   * up to MAX_RATE_LIMIT_RETRIES times, honoring `Retry-After` (seconds).
   * Never throws on an HTTP error status.
   */
  async request(
    method: MerakiMethod,
    path: string,
    opts: { body?: unknown } = {},
  ): Promise<MerakiResponse> {
    let attempts = 0
    while (true) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(`${BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        })
        const text = await res.text()

        if (res.status === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
          const retryAfterHeader = res.headers.get('retry-after')
          const retryAfterMs =
            retryAfterHeader && Number.isFinite(Number(retryAfterHeader))
              ? Number(retryAfterHeader) * 1000
              : DEFAULT_RATE_LIMIT_BACKOFF_MS
          if (retryAfterMs > MAX_RATE_LIMIT_WAIT_MS) {
            return { status: res.status, ok: false, body: text }
          }
          attempts++
          await sleep(Math.max(retryAfterMs, 250))
          continue
        }

        return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
      } catch (err) {
        return { status: 0, ok: false, body: err instanceof Error ? err.message : 'Meraki request failed' }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

/** Build a client from a resolved credential + app settings. */
export function buildMerakiClient(
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: MerakiClient } | { error: string } {
  const apiKey = resolveMerakiApiKey(credential)
  if (!apiKey) return { error: MISSING_CREDENTIAL_MESSAGE }
  const resolved = readMerakiSettings(settings)
  return { client: new MerakiClient({ apiKey, timeoutMs: resolved.timeoutMs }) }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Meraki error bodies are `{ "errors": ["message", ...] }`; fall back to the raw body. */
export function merakiErrorMessage(res: MerakiResponse): string {
  const parsed = parseJson<{ errors?: unknown }>(res.body)
  if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return parsed.errors.map((e) => String(e)).join('; ')
  }
  const trimmed = (res.body ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return `HTTP ${res.status}`
  return trimmed.length > 300 ? `HTTP ${res.status}: ${trimmed.slice(0, 297)}...` : `HTTP ${res.status}: ${trimmed}`
}

// --- Organizations (connectivity probe) --------------------------------------

export interface MerakiOrganization {
  id?: string
  name?: string
}

/** GET /organizations — every org the API key can see. Throws on error. */
export async function listOrganizations(client: MerakiClient): Promise<MerakiOrganization[]> {
  const res = await client.request('GET', '/organizations')
  if (!res.ok) throw new Error(`Failed to list organizations: ${merakiErrorMessage(res)}`)
  const parsed = parseJson<MerakiOrganization[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

// --- MX L3 (outbound) firewall rules -----------------------------------------

export interface MerakiL3FirewallRuleset {
  rules: MerakiL3FirewallRule[]
}

/**
 * GET /networks/{networkId}/appliance/firewall/l3FirewallRules — the ordered
 * custom rules for the network (the implicit final "Default rule" is NOT
 * included). Throws on error.
 */
export async function getL3FirewallRules(client: MerakiClient, networkId: string): Promise<MerakiL3FirewallRuleset> {
  const res = await client.request('GET', `/networks/${encodeURIComponent(networkId)}/appliance/firewall/l3FirewallRules`)
  if (!res.ok) {
    throw new Error(`Failed to read L3 firewall rules for network "${networkId}": ${merakiErrorMessage(res)}`)
  }
  const parsed = parseJson<MerakiL3FirewallRuleset>(res.body)
  return { rules: Array.isArray(parsed?.rules) ? (parsed!.rules as MerakiL3FirewallRule[]) : [] }
}

/**
 * PUT /networks/{networkId}/appliance/firewall/l3FirewallRules — WHOLE-LIST
 * REPLACE. `body.rules` is the complete ordered custom ruleset (excluding the
 * implicit default rule); `body.syslogDefaultRule` optionally logs that
 * implicit rule. The response only ever echoes back `{ rules: [...] }` — Meraki
 * never returns the current `syslogDefaultRule` value (on GET or PUT), so it
 * cannot be read back or diffed. Throws on error.
 */
export async function putL3FirewallRules(
  client: MerakiClient,
  networkId: string,
  body: { rules: MerakiL3FirewallRule[]; syslogDefaultRule?: boolean },
): Promise<MerakiL3FirewallRuleset> {
  const res = await client.request(
    'PUT',
    `/networks/${encodeURIComponent(networkId)}/appliance/firewall/l3FirewallRules`,
    { body },
  )
  if (!res.ok) {
    throw new Error(`Failed to update L3 firewall rules for network "${networkId}": ${merakiErrorMessage(res)}`)
  }
  const parsed = parseJson<MerakiL3FirewallRuleset>(res.body)
  return { rules: Array.isArray(parsed?.rules) ? (parsed!.rules as MerakiL3FirewallRule[]) : body.rules }
}

// --- MX L7 (application-layer) firewall rules --------------------------------

export interface MerakiL7FirewallRuleset {
  rules: MerakiL7FirewallRule[]
}

/**
 * GET /networks/{networkId}/appliance/firewall/l7FirewallRules — the ordered
 * L7 (application-layer) rules for the network. Every rule's `policy` is
 * `"deny"` (Meraki L7 has no allow rule — it only blocks on top of the
 * default-allow L3 posture). Throws on error.
 */
export async function getL7FirewallRules(client: MerakiClient, networkId: string): Promise<MerakiL7FirewallRuleset> {
  const res = await client.request('GET', `/networks/${encodeURIComponent(networkId)}/appliance/firewall/l7FirewallRules`)
  if (!res.ok) {
    throw new Error(`Failed to read L7 firewall rules for network "${networkId}": ${merakiErrorMessage(res)}`)
  }
  const parsed = parseJson<MerakiL7FirewallRuleset>(res.body)
  return { rules: Array.isArray(parsed?.rules) ? (parsed!.rules as MerakiL7FirewallRule[]) : [] }
}

/**
 * PUT /networks/{networkId}/appliance/firewall/l7FirewallRules — WHOLE-LIST
 * REPLACE of the ordered L7 ruleset. Unlike L3, there is no companion
 * "syslogDefaultRule"-style scalar; the response is always just
 * `{ rules: [...] }`. Throws on error.
 */
export async function putL7FirewallRules(
  client: MerakiClient,
  networkId: string,
  rules: MerakiL7FirewallRule[],
): Promise<MerakiL7FirewallRuleset> {
  const res = await client.request(
    'PUT',
    `/networks/${encodeURIComponent(networkId)}/appliance/firewall/l7FirewallRules`,
    { body: { rules } },
  )
  if (!res.ok) {
    throw new Error(`Failed to update L7 firewall rules for network "${networkId}": ${merakiErrorMessage(res)}`)
  }
  const parsed = parseJson<MerakiL7FirewallRuleset>(res.body)
  return { rules: Array.isArray(parsed?.rules) ? (parsed!.rules as MerakiL7FirewallRule[]) : rules }
}

// --- Group policies (per-object CRUD, reconciled by name) --------------------

/** GET /networks/{networkId}/groupPolicies — every group policy in the network. Throws on error. */
export async function listGroupPolicies(client: MerakiClient, networkId: string): Promise<MerakiGroupPolicy[]> {
  const res = await client.request('GET', `/networks/${encodeURIComponent(networkId)}/groupPolicies`)
  if (!res.ok) throw new Error(`Failed to list group policies for network "${networkId}": ${merakiErrorMessage(res)}`)
  const parsed = parseJson<MerakiGroupPolicy[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

/** POST /networks/{networkId}/groupPolicies — create; returns the created policy (with its `groupPolicyId`). Throws on error. */
export async function createGroupPolicy(
  client: MerakiClient,
  networkId: string,
  body: Record<string, unknown>,
): Promise<MerakiGroupPolicy> {
  const res = await client.request('POST', `/networks/${encodeURIComponent(networkId)}/groupPolicies`, { body })
  if (!res.ok) throw new Error(`Failed to create group policy in network "${networkId}": ${merakiErrorMessage(res)}`)
  const parsed = parseJson<MerakiGroupPolicy>(res.body)
  if (!parsed?.groupPolicyId) throw new Error(`Group policy was created in network "${networkId}" but the API returned no groupPolicyId`)
  return parsed
}

/** PUT /networks/{networkId}/groupPolicies/{groupPolicyId} — update. Throws on error. */
export async function updateGroupPolicy(
  client: MerakiClient,
  networkId: string,
  groupPolicyId: string,
  body: Record<string, unknown>,
): Promise<MerakiGroupPolicy> {
  const res = await client.request(
    'PUT',
    `/networks/${encodeURIComponent(networkId)}/groupPolicies/${encodeURIComponent(groupPolicyId)}`,
    { body },
  )
  if (!res.ok) {
    throw new Error(`Failed to update group policy "${groupPolicyId}" in network "${networkId}": ${merakiErrorMessage(res)}`)
  }
  const parsed = parseJson<MerakiGroupPolicy>(res.body)
  return parsed ?? { ...body, groupPolicyId }
}

/**
 * DELETE /networks/{networkId}/groupPolicies/{groupPolicyId}. The API also
 * accepts an optional `force` query parameter to delete a policy that still
 * has clients assigned to it — NOT used here (unverified default behavior
 * without it; deliberately conservative so a rollback/redeploy never silently
 * forces a deletion Meraki would otherwise refuse). Throws on error.
 */
export async function deleteGroupPolicy(client: MerakiClient, networkId: string, groupPolicyId: string): Promise<void> {
  const res = await client.request(
    'DELETE',
    `/networks/${encodeURIComponent(networkId)}/groupPolicies/${encodeURIComponent(groupPolicyId)}`,
  )
  if (!res.ok) {
    throw new Error(`Failed to delete group policy "${groupPolicyId}" in network "${networkId}": ${merakiErrorMessage(res)}`)
  }
}

// --- Appliance VLANs (per-object CRUD, user-supplied id) ---------------------

/**
 * GET /networks/{networkId}/appliance/vlans/settings — `{ vlansEnabled }`.
 * VLANs must be enabled on a network before any per-VLAN CRUD below will
 * succeed (an MX ships in single-LAN mode by default). Throws on error.
 */
export async function getVlansEnabled(client: MerakiClient, networkId: string): Promise<boolean> {
  const res = await client.request('GET', `/networks/${encodeURIComponent(networkId)}/appliance/vlans/settings`)
  if (!res.ok) throw new Error(`Failed to read VLAN settings for network "${networkId}": ${merakiErrorMessage(res)}`)
  const parsed = parseJson<{ vlansEnabled?: boolean }>(res.body)
  return parsed?.vlansEnabled === true
}

/** PUT /networks/{networkId}/appliance/vlans/settings — enable/disable VLANs on the network. Throws on error. */
export async function setVlansEnabled(client: MerakiClient, networkId: string, vlansEnabled: boolean): Promise<void> {
  const res = await client.request('PUT', `/networks/${encodeURIComponent(networkId)}/appliance/vlans/settings`, {
    body: { vlansEnabled },
  })
  if (!res.ok) {
    throw new Error(`Failed to ${vlansEnabled ? 'enable' : 'disable'} VLANs for network "${networkId}": ${merakiErrorMessage(res)}`)
  }
}

/** GET /networks/{networkId}/appliance/vlans — every VLAN in the network. Throws on error. */
export async function listVlans(client: MerakiClient, networkId: string): Promise<MerakiVlan[]> {
  const res = await client.request('GET', `/networks/${encodeURIComponent(networkId)}/appliance/vlans`)
  if (!res.ok) throw new Error(`Failed to list VLANs for network "${networkId}": ${merakiErrorMessage(res)}`)
  const parsed = parseJson<MerakiVlan[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

/** POST /networks/{networkId}/appliance/vlans — create; `body.id` is the caller-chosen VLAN id (1-4094). Throws on error. */
export async function createVlan(client: MerakiClient, networkId: string, body: Record<string, unknown>): Promise<MerakiVlan> {
  const res = await client.request('POST', `/networks/${encodeURIComponent(networkId)}/appliance/vlans`, { body })
  if (!res.ok) throw new Error(`Failed to create VLAN in network "${networkId}": ${merakiErrorMessage(res)}`)
  const parsed = parseJson<MerakiVlan>(res.body)
  return parsed ?? (body as unknown as MerakiVlan)
}

/** PUT /networks/{networkId}/appliance/vlans/{vlanId} — update. Throws on error. */
export async function updateVlan(
  client: MerakiClient,
  networkId: string,
  vlanId: string,
  body: Record<string, unknown>,
): Promise<MerakiVlan> {
  const res = await client.request(
    'PUT',
    `/networks/${encodeURIComponent(networkId)}/appliance/vlans/${encodeURIComponent(vlanId)}`,
    { body },
  )
  if (!res.ok) throw new Error(`Failed to update VLAN "${vlanId}" in network "${networkId}": ${merakiErrorMessage(res)}`)
  const parsed = parseJson<MerakiVlan>(res.body)
  return parsed ?? { ...(body as object), id: vlanId }
}

/** DELETE /networks/{networkId}/appliance/vlans/{vlanId}. Meraki refuses to delete the network's last remaining VLAN while VLANs are enabled (unverified in current docs — surfaces as a 400 from the API). Throws on error. */
export async function deleteVlan(client: MerakiClient, networkId: string, vlanId: string): Promise<void> {
  const res = await client.request(
    'DELETE',
    `/networks/${encodeURIComponent(networkId)}/appliance/vlans/${encodeURIComponent(vlanId)}`,
  )
  if (!res.ok) throw new Error(`Failed to delete VLAN "${vlanId}" in network "${networkId}": ${merakiErrorMessage(res)}`)
}
