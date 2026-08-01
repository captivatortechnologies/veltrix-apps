import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { thehiveRequest, buildAuthHeader, PRIMARY } from '../lib/thehiveApi'

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

/** Normalize a raw endpoint/host into a base URL with no trailing slash (https default). */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

// =============================================================================
// TheHive — connection test.
//
// Verifies a Connection's endpoint + API key by calling the TheHive REST API
// (GET /api/v1/user/current, Bearer, self-signed tolerated). A 200 confirms the
// endpoint resolves AND the key authenticates; a 401/403 proves reachability but
// flags the key. Verify against a live TheHive (see README, v4 vs v5).
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }
  if (!ctx.credential.apiToken) {
    return { ok: false, message: 'TheHive authenticates with a Bearer API key — attach one to this connection.' }
  }

  const started = Date.now()
  try {
    const res = await thehiveRequest(`${base}${PRIMARY.currentUser}`, { headers: buildAuthHeader(ctx.credential), timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached TheHive but authentication failed (HTTP ${res.status}). Check the API key.`,
        details: [`Endpoint: ${base}`, 'Auth: Bearer API key'],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `TheHive returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to TheHive (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, 'Auth: Bearer API key'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that TheHive is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
