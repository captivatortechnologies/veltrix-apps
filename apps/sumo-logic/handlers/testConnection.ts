import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { normalizeBaseUrl, buildAuthHeader, hasBasicAuth, sumoRequest } from '../lib/sumoLogicApi'

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

/** Resolve the Management API base URL (`…/api/v1`) from the connection. */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  return normalizeBaseUrl(raw)
}

// =============================================================================
// Sumo Logic — connection test.
//
// Verifies a Connection's deployment endpoint + Access ID / Access Key by calling
// the Management API (GET /extractionRules, HTTPS). A 200 confirms the deployment
// resolves AND the key authenticates with Field Extraction Rules access; a 401/403
// proves reachability but flags the key/scope.
//   API: https://www.sumologic.com/help/docs/api/field-extraction-rules/
//   Auth: https://help.sumologic.com/docs/api/about-apis/getting-started/
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No deployment endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }
  if (!hasBasicAuth(ctx.credential)) {
    return { ok: false, message: 'Sumo Logic authenticates with an Access ID and Access Key — attach both to this connection.' }
  }

  const started = Date.now()
  try {
    const res = await sumoRequest(`${base}/extractionRules`, { headers: buildAuthHeader(ctx.credential), timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached Sumo Logic but authentication failed (HTTP ${res.status}). Check the Access ID / Access Key and its permissions.`,
        details: [`Endpoint: ${base}`, 'Auth: Access ID + Access Key'],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Sumo Logic returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to Sumo Logic (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, 'Auth: Access ID + Access Key'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}. Check the deployment region.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
