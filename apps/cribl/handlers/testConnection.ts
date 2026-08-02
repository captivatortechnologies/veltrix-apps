import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { criblRequest, resolveBearer, apiRoot, DEFAULT_CRIBL_PORT } from '../lib/criblApi'

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

/**
 * Normalize a raw endpoint/host into an https base URL (no trailing slash). When
 * the endpoint carries no explicit port, the configured Cribl API port (default
 * 9000 on-prem; set 443 for Cribl.Cloud) is applied.
 */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (!url.port) {
    const port = Number(ctx.settings?.cribl_api_port) || DEFAULT_CRIBL_PORT
    if (port !== 443) url.port = String(port)
  }
  return url.toString().replace(/\/+$/, '')
}

// =============================================================================
// Cribl — connection test.
//
// Verifies a Connection's endpoint + credential by obtaining a Bearer (on-prem
// username+password login, or a Cloud/direct token) and calling the Cribl REST
// API (GET /api/v1/system/info, HTTPS, self-signed tolerated). A 2xx confirms the
// endpoint resolves AND the credential authenticates. Verify /api/v1/system/info
// against a live Cribl.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }

  const hasToken = Boolean(ctx.credential.apiToken && ctx.credential.apiToken.trim())
  const hasLogin = Boolean(ctx.credential.username && ctx.credential.password)
  if (!hasToken && !hasLogin) {
    return { ok: false, message: 'Cribl authenticates with a Bearer token (Cribl.Cloud) or a username + password (on-prem) — attach one to this connection.' }
  }
  const authKind = hasToken ? 'Bearer token' : 'username + password (login)'

  const started = Date.now()
  try {
    const headers = await resolveBearer(base, ctx.credential, TIMEOUT_MS).then((token) => ({ Authorization: `Bearer ${token}` }))
    const res = await criblRequest(`${apiRoot(base)}/system/info`, { headers, timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached Cribl but authentication failed (HTTP ${res.status}). Check the credential.`,
        details: [`Endpoint: ${base}`, `Auth: ${authKind}`],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Cribl returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to Cribl (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, `Auth: ${authKind}`],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/login failed/i.test(msg)) return { ok: false, message: `Reached Cribl but login failed. Check the username and password. (${msg})`, details: [`Endpoint: ${base}`], latencyMs }
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that Cribl is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
