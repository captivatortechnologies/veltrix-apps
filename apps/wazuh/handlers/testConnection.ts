import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { wazuhRequest, DEFAULT_WAZUH_API_PORT } from '../lib/wazuhApi'

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

/** Normalize a raw endpoint/host into an https base URL (default port 55000), no trailing slash. */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const url = new URL(withScheme)
  if (!url.port) url.port = String(DEFAULT_WAZUH_API_PORT)
  return url.toString().replace(/\/+$/, '')
}

// =============================================================================
// Wazuh — connection test.
//
// Verifies a Connection's endpoint + credential by authenticating against the
// Wazuh REST API (HTTPS 55000, self-signed tolerated). A token in the response
// confirms both reachability and a valid credential; a 401/403 proves the manager
// is reachable but flags the credential.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }

  const encoded = Buffer.from(`${ctx.credential.username ?? ''}:${ctx.credential.password ?? ''}`).toString('base64')
  const started = Date.now()
  try {
    const res = await wazuhRequest(`${base}/security/user/authenticate`, {
      method: 'POST',
      headers: { Authorization: `Basic ${encoded}` },
      timeoutMs: TIMEOUT_MS,
    })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached the Wazuh API but authentication failed (HTTP ${res.status}). Check the API username & password.`,
        details: [`Endpoint: ${base}`],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Wazuh API returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }

    const token = (() => {
      try {
        return (JSON.parse(res.body || '{}') as { data?: { token?: string } }).data?.token
      } catch {
        return undefined
      }
    })()
    if (!token) {
      return { ok: false, message: `Wazuh API responded (HTTP ${res.status}) but returned no token.`, details: [`Endpoint: ${base}`], latencyMs }
    }

    return {
      ok: true,
      message: `Authenticated to the Wazuh manager API (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, 'Auth: username & password → bearer token'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port (55000) and that the Wazuh API is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
