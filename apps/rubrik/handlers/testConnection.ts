import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildRubrikBaseUrl,
  createServiceAccountSession,
  getJson,
  readRubrikSettings,
  resolveServiceAccount,
  authHeader,
} from '../lib/rubrikApi'

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

/** Normalize a raw endpoint/host into an https base URL with no trailing slash. */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  return buildRubrikBaseUrl({ hostname: raw, port: '' })
}

// =============================================================================
// Rubrik — connection test.
//
// Verifies a Connection's cluster endpoint + service-account credential against
// the Rubrik CDM REST API (HTTPS, self-signed tolerated):
//   1. POST /api/v1/service_account/session  { serviceAccountId, secret } -> token
//   2. GET  /api/v1/cluster/me               (proves the cluster answers)
// A failed session flags the credential; a failed cluster read flags reachability.
// Verify these endpoints against a live Rubrik CDM cluster.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No cluster endpoint is configured for this connection.' }

  const account = resolveServiceAccount(ctx.credential)
  if (!account) {
    return {
      ok: false,
      message: 'Rubrik authenticates with a service account — store its id in the credential username and its secret in the API token field.',
    }
  }

  const settings = readRubrikSettings(ctx.settings)
  const started = Date.now()
  try {
    const token = await createServiceAccountSession(base, account, { verifyTls: settings.verifyTls, timeoutMs: settings.timeoutMs })
    const conn = { base, headers: authHeader(token), settings }
    const cluster = await getJson<{ name?: string; version?: string }>(conn, '/api/v1/cluster/me', settings.timeoutMs)
    const latencyMs = Date.now() - started
    return {
      ok: true,
      message: `Connected to Rubrik cluster${cluster?.name ? ` "${cluster.name}"` : ''}${cluster?.version ? ` (CDM ${cluster.version})` : ''}.`,
      details: [`Endpoint: ${base}`, `Service account: ${account.serviceAccountId}`, 'Auth: service-account session (Bearer)'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/session failed → HTTP 40[13]/i.test(msg)) {
      return { ok: false, message: 'Reached Rubrik but the service-account session was rejected — check the service account id and secret.', details: [`Endpoint: ${base}`], latencyMs }
    }
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the address and that the cluster is reachable.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
