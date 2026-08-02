import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { API_BASE_PATH, buildPsAuthHeader, psRequest, signOut } from '../lib/beyondtrustApi'

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
 * Normalize a raw endpoint/host into the Password Safe public API base URL
 * (`https://<host>/BeyondTrust/api/public/v3`, no trailing slash). Accepts a bare
 * host, a full origin, or a URL that already includes the API base path.
 */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const origin = withScheme.replace(/\/+$/, '').replace(new RegExp(`${API_BASE_PATH}/?$`, 'i'), '')
  return `${origin}${API_BASE_PATH}`
}

// =============================================================================
// BeyondTrust Password Safe — connection test.
//
// Verifies a Connection's host + API key + run-as user by starting a PS-Auth
// session (POST /Auth/SignAppIn, HTTPS, self-signed tolerated) and signing back
// out. A 200 confirms the endpoint resolves AND the credential authenticates; a
// 401/403 proves reachability but flags the key / run-as user. Verify against a
// live BeyondTrust instance.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }
  if (!ctx.credential.apiToken) {
    return { ok: false, message: 'Password Safe authenticates with an API key — attach one to this connection.' }
  }

  const started = Date.now()
  try {
    const res = await psRequest(`${base}/Auth/SignAppIn`, {
      method: 'POST',
      headers: buildPsAuthHeader(ctx.credential),
      timeoutMs: TIMEOUT_MS,
    })
    const latencyMs = Date.now() - started
    const runas = (ctx.credential.username || '').trim()
    const details = [`Endpoint: ${base}`, `Auth: PS-Auth key${runas ? ` (run-as ${runas})` : ''}`]

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached Password Safe but authentication failed (HTTP ${res.status}). Check the API key and run-as user.`,
        details,
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Password Safe returned HTTP ${res.status}.`, details, latencyMs }
    }
    if (!res.ok) {
      return { ok: false, message: `Password Safe sign-in returned HTTP ${res.status}.`, details, latencyMs }
    }

    // Signed in — release the session we just opened (best-effort).
    if (res.cookie) await signOut(base, res.cookie, TIMEOUT_MS)
    return { ok: true, message: `Signed in to Password Safe (HTTP ${res.status}).`, details, latencyMs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that Password Safe is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
