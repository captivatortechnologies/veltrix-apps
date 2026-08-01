import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { vectraRequest, buildAuthHeader, VECTRA_API_VERSION } from '../lib/vectraApi'

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
function resolveOrigin(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

// =============================================================================
// Vectra AI — connection test.
//
// Verifies a Connection's endpoint + API token by calling the Vectra Detect REST
// API (GET /api/v2.5/rules?page_size=1, HTTPS, self-signed tolerated). A 2xx
// confirms the endpoint resolves AND the token authenticates; a 401/403 proves
// reachability but flags the token. Verify against a live Vectra brain.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const origin = resolveOrigin(ctx)
  if (!origin) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }
  if (!ctx.credential.apiToken) {
    return { ok: false, message: 'Vectra authenticates with an API token — attach one to this connection.' }
  }

  const url = `${origin}/api/${VECTRA_API_VERSION}/rules?page_size=1`
  const started = Date.now()
  try {
    const res = await vectraRequest(url, { headers: buildAuthHeader(ctx.credential), timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached Vectra but authentication failed (HTTP ${res.status}). Check the API token.`,
        details: [`Endpoint: ${origin}`, 'Auth: API token'],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Vectra returned HTTP ${res.status}.`, details: [`Endpoint: ${origin}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to Vectra (HTTP ${res.status}).`,
      details: [`Endpoint: ${origin}`, `API: ${VECTRA_API_VERSION}`, 'Auth: API token'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${origin}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${origin}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${origin}. Check the port and that Vectra is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${origin}: ${msg}`, latencyMs }
  }
}
