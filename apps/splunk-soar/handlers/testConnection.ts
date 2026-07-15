import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildAuthHeader } from '../lib/soarApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves when it loads the
// handler — older SDKs predate these type exports. Only long-standing types
// (CredentialRef) are imported.
interface TestConnectionContext {
  appId: string
  customerId: string
  endpoint: string | null
  credential: CredentialRef | null
  component: { hostname?: string | null } | null
  connectivity: unknown
  settings: Record<string, unknown>
}
interface TestConnectionResult {
  ok: boolean
  message: string
  details?: string[]
  latencyMs?: number
}

// =============================================================================
// Splunk SOAR — connection test.
//
// Verifies a Connection by calling the SOAR REST API: `GET {base}/rest/version`.
// A 2xx confirms the appliance is reachable AND the credential authenticates;
// 401/403 = bad token / basic auth, 404 = the URL is not a SOAR REST endpoint.
// Authenticates with the automation user API token (`ph-auth-token` header) when
// present, otherwise HTTP Basic — the same auth soarApi.ts uses for every
// pipeline handler. Runs in-process on the platform with the decrypted credential.
// =============================================================================

const PROBE_PATH = '/rest/version'
const DEFAULT_TIMEOUT_MS = 30_000

/** Ensure the endpoint carries an https scheme and no trailing slash. */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

/** Timeout for the probe, from the app's request_timeout_seconds setting. */
function resolveTimeoutMs(settings: Record<string, unknown>): number {
  const raw = settings.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : DEFAULT_TIMEOUT_MS
}

/**
 * Which secret the credential can authenticate with, if any. Mirrors
 * soarApi.buildAuthHeader: automation API token preferred, HTTP Basic fallback.
 */
function resolveAuthMethod(credential: CredentialRef): 'token' | 'basic' | null {
  if (credential.apiToken && credential.apiToken.trim().length > 0) return 'token'
  if (credential.username && credential.username.trim().length > 0) return 'basic'
  return null
}

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Splunk SOAR at ${baseUrl}. Check the endpoint and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${baseUrl}. Check the SOAR endpoint host.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  if (/certificate|self[-\s]?signed|SSL|TLS/i.test(msg)) return `TLS error reaching ${baseUrl}: ${msg}`
  return `Could not reach Splunk SOAR (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) return { ok: false, message: 'No endpoint is configured for this connection.' }

  if (!ctx.credential) {
    return { ok: false, message: 'No credential is attached to this connection.' }
  }
  const authMethod = resolveAuthMethod(ctx.credential)
  if (!authMethod) {
    return {
      ok: false,
      message: 'No usable credential found. Store a SOAR automation API token, or a username and password, on the connection.',
    }
  }

  const baseUrl = normalizeBaseUrl(host)
  const authLabel = authMethod === 'token' ? 'automation API token' : 'HTTP Basic (username/password)'
  const headers = { ...buildAuthHeader(ctx.credential), Accept: 'application/json' }
  const timeoutMs = resolveTimeoutMs(ctx.settings)
  const started = Date.now()

  try {
    const res = await fetch(`${baseUrl}${PROBE_PATH}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Splunk SOAR rejected the credential (HTTP ${res.status}). Check the ${authLabel}.`,
        details: [`Endpoint: ${baseUrl}`, `Auth: ${authLabel}`],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `No SOAR REST API was found at ${baseUrl} (404). Check the endpoint URL.`,
        details: [`Probed: ${baseUrl}${PROBE_PATH}`],
        latencyMs,
      }
    }
    if (res.ok) {
      return {
        ok: true,
        message: `Connected to Splunk SOAR at ${baseUrl}.`,
        details: [`Endpoint: ${baseUrl}`, `Auth: ${authLabel}`],
        latencyMs,
      }
    }
    const body = await res.text().catch(() => '')
    return {
      ok: false,
      message: `Splunk SOAR returned HTTP ${res.status}.`,
      details: [`Endpoint: ${baseUrl}`, ...(body ? [`Response: ${body.slice(0, 200)}`] : [])],
      latencyMs,
    }
  } catch (err) {
    return {
      ok: false,
      message: classifyNetworkError(err, baseUrl),
      details: [`Endpoint: ${baseUrl}`, `Auth: ${authLabel}`],
      latencyMs: Date.now() - started,
    }
  }
}
