import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { baseUrlFromEndpoint, resolveTaniumSession, taniumRequest, sessionHeader } from '../lib/taniumApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever SDK the platform resolves.
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

/** Normalize the connection endpoint/host into a `https://host/api/v2` base URL. */
function resolveBase(ctx: TestConnectionContext): string | null {
  return baseUrlFromEndpoint(ctx.endpoint || ctx.component?.hostname || '')
}

// =============================================================================
// Tanium — connection test.
//
// Verifies a Connection's endpoint + credential against the Tanium REST v2 API.
// Resolves a session (API token verbatim, or username/password via
// /api/v2/session/login) then GET /api/v2/system_status (HTTPS, self-signed
// tolerated). A login failure or a 401/403 proves reachability but flags the
// credential; any status below 500 confirms Tanium answered. Verify
// /api/v2/system_status against a live Tanium.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBase(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }

  const cred = ctx.credential
  const hasToken = Boolean(cred.apiToken && cred.apiToken.trim())
  const hasBasic = Boolean((cred.username ?? '').trim() && cred.password)
  if (!hasToken && !hasBasic) {
    return { ok: false, message: 'Tanium authenticates with an API token, or a username and password — attach one to this connection.' }
  }
  const authLabel = hasToken ? 'API token' : 'username/password'

  const started = Date.now()
  try {
    const session = await resolveTaniumSession(base, cred, TIMEOUT_MS)
    const res = await taniumRequest(`${base}/system_status`, { headers: sessionHeader(session), timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached Tanium but authentication failed (HTTP ${res.status}). Check the credential.`,
        details: [`Endpoint: ${base}`, `Auth: ${authLabel}`],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Tanium returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to Tanium (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, `Auth: ${authLabel}`],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/session\/login|no session token|needs an API token/i.test(msg)) {
      return { ok: false, message: `Reached Tanium but login failed: ${msg}`, details: [`Endpoint: ${base}`, `Auth: ${authLabel}`], latencyMs }
    }
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that Tanium is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
