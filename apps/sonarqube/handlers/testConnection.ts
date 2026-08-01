import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { sonarqubeRequest, buildAuthHeader } from '../lib/sonarqubeApi'

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

/** Normalize a raw endpoint/host into a base URL with no trailing slash. Honours an
 * explicit http/https scheme; otherwise assumes https. The Web API lives under `/api`. */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

// =============================================================================
// SonarQube — connection test.
//
// Verifies a Connection's endpoint + API token against the SonarQube Web API:
//   GET /api/system/status            → server reachable + version (unauthenticated)
//   GET /api/authentication/validate  → the token authenticates ({ valid: true })
// HTTP(S), self-signed TLS tolerated. Verify against your SonarQube version.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }
  if (!ctx.credential.apiToken) {
    return { ok: false, message: 'SonarQube authenticates with an API token — attach one to this connection.' }
  }

  const headers = buildAuthHeader(ctx.credential)
  const started = Date.now()
  try {
    const statusRes = await sonarqubeRequest(`${base}/api/system/status`, { headers, timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started

    if (statusRes.status <= 0 || statusRes.status >= 500) {
      return { ok: false, message: `SonarQube returned HTTP ${statusRes.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }

    let version: string | undefined
    let status: string | undefined
    try {
      const parsed = JSON.parse(statusRes.body || '{}') as { version?: string; status?: string }
      version = parsed.version
      status = parsed.status
    } catch {
      /* non-JSON — likely not a SonarQube endpoint */
    }

    // Confirm the token authenticates.
    const authRes = await sonarqubeRequest(`${base}/api/authentication/validate`, { headers, timeoutMs: TIMEOUT_MS })
    let valid = false
    try {
      valid = (JSON.parse(authRes.body || '{}') as { valid?: boolean }).valid === true
    } catch {
      /* ignore */
    }
    if (authRes.status === 401 || authRes.status === 403 || !valid) {
      return {
        ok: false,
        message: `Reached SonarQube${version ? ` (v${version})` : ''} but the API token was not accepted. Check the token.`,
        details: [`Endpoint: ${base}`, 'Auth: API token'],
        latencyMs: Date.now() - started,
      }
    }

    return {
      ok: true,
      message: `Connected to SonarQube${version ? ` v${version}` : ''}${status ? ` (${status})` : ''}.`,
      details: [`Endpoint: ${base}`, 'Auth: API token'],
      latencyMs: Date.now() - started,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that SonarQube is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
