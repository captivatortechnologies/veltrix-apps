import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildApiBase, normalizeBaseUrl, resolveApiToken, authentikRequest, bearer, MISSING_CREDENTIAL_MESSAGE } from '../lib/authentikApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves at load time.
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

const TIMEOUT_MS = 10_000

// =============================================================================
// authentik — connection test.
//
// Verifies a Connection's endpoint + static API token with a single read:
// GET /api/v3/core/applications/?page_size=1, `Authorization: Bearer <token>`.
// A 2xx confirms the host resolves, TLS negotiates (self-signed tolerated
// unless `verify_tls` is on) and the token is accepted with permission to view
// applications; 401/403 flags the token; other failures are classified for an
// actionable message.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return { ok: false, message: 'No endpoint is configured for this connection. Set your authentik instance host (e.g. authentik.example.com).' }
  }

  const token = resolveApiToken(ctx.credential)
  if (!token) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const verifyTls = ctx.settings?.verify_tls === true
  const base = buildApiBase(normalizeBaseUrl(host))
  const url = `${base}/core/applications/?page_size=1`
  const details = [`Endpoint: ${base}`, 'Auth: static API token (Bearer)']
  const started = Date.now()

  try {
    const res = await authentikRequest(url, { headers: bearer(token), timeoutMs: TIMEOUT_MS, verifyTls })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `authentik rejected the API token (HTTP ${res.status}). Verify the token and that it has permission to view applications.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return { ok: false, message: `authentik API not found (404) at ${base}. Check the host and that it is running authentik.`, details, latencyMs }
    }
    if (!res.ok) {
      return { ok: false, message: `authentik returned HTTP ${res.status}: ${res.body.slice(0, 200)}`, details, latencyMs }
    }
    return { ok: true, message: `Connected to authentik (${base}).`, details, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    return { ok: false, message: classifyTransportError(err instanceof Error ? err.message : String(err), base), details, latencyMs }
  }
}

/** Turn a transport-level error into an operator-actionable message. */
function classifyTransportError(message: string, base: string): string {
  if (/abort|timed?\s?out/i.test(message)) {
    return `Timed out reaching authentik at ${base}. Check the endpoint and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) {
    return `Could not resolve the authentik host in "${base}".`
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `Connection refused by ${base}.`
  }
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(message)) {
    return `TLS/certificate error reaching ${base}: ${message}. If this is a self-hosted instance with a self-signed certificate, leave "Verify TLS certificate" off.`
  }
  return `Could not reach authentik (${base}): ${message}`
}
