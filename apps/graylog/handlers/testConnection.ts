import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { graylogRequest, buildAuthHeader, DEFAULT_GRAYLOG_PORT } from '../lib/graylogApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever SDK the platform resolves.
interface TestConnectionContext {
  appId: string
  customerId: string
  endpoint: string | null
  credential: CredentialRef | null
  component: { hostname?: string | null; port?: string | number | null } | null
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

/**
 * Normalize a raw endpoint/host into a base URL with no trailing slash and no
 * `/api` suffix. Honours a scheme already on the endpoint; otherwise defaults to
 * HTTPS on the configured port (443 → no port suffix).
 */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '')
  const port = Number(ctx.component?.port) || DEFAULT_GRAYLOG_PORT
  const scheme = port === 443 ? 'https' : port === 80 ? 'http' : 'https'
  const portPart = port === 443 || port === 80 ? '' : `:${port}`
  return `${scheme}://${raw}${portPart}`
}

// =============================================================================
// Graylog — connection test.
//
// Verifies a Connection's endpoint + credential by calling the Graylog REST API
// (GET /api/system, HTTP Basic, self-signed tolerated). A 200 confirms the
// endpoint resolves AND the credential authenticates; a 401/403 proves
// reachability but flags the credential. Verify /api/system against a live Graylog.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }
  const hasAuth = Boolean(ctx.credential.apiToken || ctx.credential.username)
  if (!hasAuth) {
    return { ok: false, message: 'Graylog authenticates with a user (username + password) or an access token — attach one to this connection.' }
  }

  const authKind = ctx.credential.apiToken ? 'access token' : 'user + password'
  const started = Date.now()
  try {
    const res = await graylogRequest(`${base}/api/system`, { headers: buildAuthHeader(ctx.credential), timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached Graylog but authentication failed (HTTP ${res.status}). Check the credential.`,
        details: [`Endpoint: ${base}`, `Auth: ${authKind}`],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Graylog returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to Graylog (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, `Auth: ${authKind}`],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that Graylog is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
