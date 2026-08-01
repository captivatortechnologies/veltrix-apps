import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { axoniusRequest, buildAuthHeaders, apiUrl, verifyTls } from '../lib/axoniusApi'
import { META_ABOUT_RESOURCE } from '../config-types/saved-queries/_shared'

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
// Axonius — connection test.
//
// Verifies a Connection's endpoint + API key/secret by calling the Axonius REST
// API (GET api/settings/meta/about, HTTPS, self-signed tolerated). A 200 confirms
// the endpoint resolves AND the credentials authenticate; a 401/403 proves
// reachability but flags the credentials. Verify the endpoint against a live
// Axonius tenant.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }

  const headers = buildAuthHeaders(ctx.credential)
  if (Object.keys(headers).length !== 2) {
    return { ok: false, message: 'Axonius authenticates with an API key and API secret — store the key as the username and the secret as the token.' }
  }

  const started = Date.now()
  try {
    const res = await axoniusRequest(apiUrl(base, ctx.settings, META_ABOUT_RESOURCE), {
      headers,
      timeoutMs: TIMEOUT_MS,
      verifyTls: verifyTls(ctx.settings),
    })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached Axonius but authentication failed (HTTP ${res.status}). Check the API key and secret.`,
        details: [`Endpoint: ${base}`, 'Auth: api-key + api-secret'],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Axonius returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to Axonius (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, 'Auth: api-key + api-secret'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that Axonius is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
