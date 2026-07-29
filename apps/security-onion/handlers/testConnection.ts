import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { soRequest, buildAuthHeader } from '../lib/soConsole'

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

/** Normalize a raw endpoint/host into an https base URL with no trailing slash. */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

// =============================================================================
// Security Onion — connection test.
//
// Verifies a Connection's endpoint + credential by hitting the SOC console login
// page (HTTPS, self-signed tolerated). A reachable response confirms the manager
// is up and the endpoint resolves; a 401/403 still proves reachability but flags
// the credential.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }

  const authType = ctx.credential.apiToken ? 'API token' : 'username & password'
  const started = Date.now()
  try {
    const res = await soRequest(`${base}/login`, { headers: buildAuthHeader(ctx.credential), timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached the SOC console but authentication failed (HTTP ${res.status}). Check the credential.`,
        details: [`Endpoint: ${base}`, `Auth: ${authType}`],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `SOC console returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to the Security Onion SOC console (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, `Auth: ${authType}`],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that the SOC console is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
