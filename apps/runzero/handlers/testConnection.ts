import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { runzeroRequest, buildAuthHeader, resolveRunzeroToken, normalizeHost, RUNZERO_API_PATH, MISSING_CREDENTIAL_MESSAGE } from '../lib/runzeroApi'

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

// =============================================================================
// runZero — connection test.
//
// Verifies a Connection's endpoint + Organization API key by calling the runZero
// console API (GET /org/sites, Bearer auth). A 2xx confirms the endpoint resolves
// AND the key authenticates against the org; a 401/403 proves reachability but
// flags the key. Defaults to the hosted console when no endpoint is supplied.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveRunzeroToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const host = normalizeHost(ctx.endpoint || ctx.component?.hostname)
  const base = `https://${host}${RUNZERO_API_PATH}`
  const details = [`Endpoint: ${base}`, 'Auth: Organization API key (Bearer)']
  const started = Date.now()

  try {
    const res = await runzeroRequest(`${base}/org/sites`, { headers: buildAuthHeader(ctx.credential), timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached runZero but authentication failed (HTTP ${res.status}). Check the Organization API key.`,
        details,
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `runZero returned HTTP ${res.status}.`, details, latencyMs }
    }
    if (!res.ok) {
      return { ok: false, message: `runZero returned HTTP ${res.status}: ${res.body.slice(0, 200)}`, details, latencyMs }
    }
    return { ok: true, message: `Connected to runZero (HTTP ${res.status}).`, details, latencyMs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, details, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, details, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}.`, details, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, details, latencyMs }
  }
}
