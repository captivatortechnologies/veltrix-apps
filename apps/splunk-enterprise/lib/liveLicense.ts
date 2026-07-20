// =============================================================================
// Live Splunk licenser status — best-effort real-time read over a tenant's
// Splunk Connection. Degrades gracefully to { available: false } whenever a
// connection can't be resolved or the instance can't be reached, so the License
// page always renders (the recorded-XML path is the always-available source).
//
// HOW A CONNECTION RESOLVES
// -------------------------
// The client passes the id of one of the tenant's Splunk Connections (a stored
// Credential). The route hands it to the platform's first-class credential seam,
// `ctx.resolveConnection(customerId, credentialId)`, which returns the endpoint
// plus the DECRYPTED secret — tenant-scoped and server-side only. The app no
// longer touches the platform's Credential/Tool tables or mirrors its decrypt
// scheme; the platform owns both. Every step below still fails CLOSED to
// { available: false }, so the page never breaks when a connection is missing or
// the instance is unreachable.
// =============================================================================

import type { AppRouteContext, CredentialRef } from '@veltrixsecops/app-sdk'
import { buildAuthHeader, getJson } from './splunkApi'

const LIVE_TIMEOUT_MS = 12_000
const DAY_MS = 24 * 60 * 60 * 1000

// --- Public result shapes ---------------------------------------------------

export interface LiveLicenseStack {
  stackId: string
  label: string
  type: string
  /** Daily indexing entitlement in bytes (summed across the stack's licenses). */
  quotaBytes: number
  /** Bytes indexed in the current window, or null when pool data is unavailable. */
  usedBytes: number | null
  /** Splunk's own status string for the license(s), e.g. "VALID" / "EXPIRED". */
  status: string
  /** Earliest expiry across the stack's licenses (ISO), or null. */
  expirationTime: string | null
  /** Whole days until that expiry; negative once expired, null when unknown. */
  daysToExpiry: number | null
}

export type LiveUnavailableReason = 'no-connection' | 'unreachable' | 'auth' | 'error'

export interface LiveLicenseResult {
  available: boolean
  reason?: LiveUnavailableReason
  message?: string
  /** The Splunk management endpoint the status was read from (when available). */
  endpoint?: string
  stacks?: LiveLicenseStack[]
}

/** Normalize a stored endpoint into an https base URL with no trailing slash. */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

// --- Response mapping (pure) ------------------------------------------------

/** Extract a Splunk REST list response's `entry[].content` records. */
function contentEntries(json: any): Array<Record<string, any>> {
  const entries = Array.isArray(json?.entry) ? json.entry : []
  return entries.map((e: any) => (e && typeof e.content === 'object' ? e.content : {}))
}

/**
 * Map raw /services/licenser/licenses (+ optional /services/licenser/pools)
 * responses into per-stack usage/quota/status. Pure — unit tested directly.
 * `pools` may be null when that call was unavailable; usage is then null.
 */
export function mapLiveLicenses(
  licensesJson: any,
  poolsJson: any | null,
  now: Date = new Date(),
): LiveLicenseStack[] {
  const byStack = new Map<string, LiveLicenseStack>()

  for (const c of contentEntries(licensesJson)) {
    const stackId = String(c.stack_id ?? c.stackId ?? 'unknown')
    const quota = Number(c.quota ?? 0) || 0
    const expEpoch = Number(c.expiration_time ?? 0)
    const expDate = Number.isFinite(expEpoch) && expEpoch > 0 ? new Date(expEpoch * 1000) : null

    const existing = byStack.get(stackId)
    if (existing) {
      existing.quotaBytes += quota
      // Keep the earliest expiry across the stack's licenses.
      if (expDate && (!existing.expirationTime || expDate.getTime() < new Date(existing.expirationTime).getTime())) {
        existing.expirationTime = expDate.toISOString()
      }
    } else {
      byStack.set(stackId, {
        stackId,
        label: String(c.label ?? ''),
        type: String(c.type ?? ''),
        quotaBytes: quota,
        usedBytes: null,
        status: String(c.status ?? ''),
        expirationTime: expDate ? expDate.toISOString() : null,
        daysToExpiry: null,
      })
    }
  }

  // Fold in real-time usage from pools (used_bytes, grouped by stack).
  if (poolsJson) {
    for (const p of contentEntries(poolsJson)) {
      const stackId = String(p.stack_id ?? p.stackId ?? 'unknown')
      const used = Number(p.used_bytes ?? 0) || 0
      const stack = byStack.get(stackId)
      if (stack) stack.usedBytes = (stack.usedBytes ?? 0) + used
    }
  }

  // Finalize days-to-expiry.
  for (const stack of byStack.values()) {
    if (stack.expirationTime) {
      stack.daysToExpiry = Math.ceil((new Date(stack.expirationTime).getTime() - now.getTime()) / DAY_MS)
    }
  }

  return [...byStack.values()].sort((a, b) => a.stackId.localeCompare(b.stackId))
}

/**
 * Orchestrate the live read: resolve the tenant's chosen Connection through the
 * platform seam, pull licenser licenses (required) and pools (best-effort for
 * usage), and map. Never throws — always returns a { available } result the page
 * can render directly.
 */
export async function getLiveLicenseStatus(
  resolveConnection: AppRouteContext['resolveConnection'],
  customerId: string,
  credentialId: string,
): Promise<LiveLicenseResult> {
  const conn = await resolveConnection(customerId, credentialId)
  if (!conn || !conn.endpoint) return { available: false, reason: 'no-connection' }

  const baseUrl = normalizeBaseUrl(conn.endpoint)
  // buildAuthHeader only reads apiToken/username/password; a ResolvedConnection
  // carries the rest of CredentialRef too, so this is auth material only.
  const auth = buildAuthHeader({
    apiToken: conn.apiToken,
    username: conn.username,
    password: conn.password,
  } as CredentialRef)

  let licensesJson: any
  try {
    licensesJson = await getJson(baseUrl, auth, '/services/licenser/licenses', LIVE_TIMEOUT_MS)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const reason: LiveUnavailableReason = /\b401\b|auth/i.test(message) ? 'auth' : 'unreachable'
    return { available: false, reason, message, endpoint: baseUrl }
  }

  // Pools give real-time used_bytes; treat as best-effort (older/locked-down
  // instances may not expose it) so usage simply shows as unknown if it fails.
  let poolsJson: any | null = null
  try {
    poolsJson = await getJson(baseUrl, auth, '/services/licenser/pools', LIVE_TIMEOUT_MS)
  } catch {
    poolsJson = null
  }

  return {
    available: true,
    endpoint: baseUrl,
    stacks: mapLiveLicenses(licensesJson, poolsJson),
  }
}
