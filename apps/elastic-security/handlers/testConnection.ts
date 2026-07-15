import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildElasticClient, resolveElasticAuth, elasticErrorMessage } from '../lib/elastic'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves when it loads the
// handler — older SDKs predate these type exports. Only long-standing types
// (CredentialRef) are imported.
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

// =============================================================================
// Elastic Security — connection test.
//
// Verifies a Connection by calling the Kibana Detections API with the Connection's
// credential: `GET /api/detection_engine/rules/_find?per_page=1`. This is the same
// lightweight, authenticated probe the detection-rules health check uses. A 2xx
// confirms the endpoint is a reachable Kibana AND the API key authenticates;
// 401/403 = bad/under-privileged key, 404 = wrong endpoint. The component hostname
// (or the Connection endpoint) is the Kibana base URL; the credential carries the
// Elastic API key (base64 `id:api_key`, sent as `Authorization: ApiKey <...>`).
// Runs in-process on the platform with the decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, kibanaUrl: string): string {
  // fetch surfaces low-level failures as a TypeError with the real cause nested.
  const cause = (err as { cause?: unknown })?.cause
  const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : ''
  const msg = `${err instanceof Error ? err.message : String(err)} ${causeMsg}`.trim()

  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching Kibana at ${kibanaUrl}. Check the endpoint and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${kibanaUrl}. Check the Kibana base URL.`
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${kibanaUrl}.`
  if (/cert|self.signed|SSL|TLS|DEPTH_ZERO|UNABLE_TO_VERIFY|ERR_TLS/i.test(msg)) {
    return `TLS error connecting to ${kibanaUrl}: ${msg}`
  }
  return `Could not reach Kibana (${kibanaUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) return { ok: false, message: 'No Kibana endpoint is configured for this connection.' }

  const auth = resolveElasticAuth(ctx.credential)
  if (!auth) {
    return {
      ok: false,
      message:
        'No Elastic credential found. Store an Elastic API key (the base64 “id:api_key” value) in the ' +
        'connection’s API token field, or a username + password for Basic auth.',
    }
  }

  const built = buildElasticClient(host, ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client, kibanaUrl } = built

  const authLabel = ctx.credential?.apiToken?.trim() ? 'Elastic API key' : 'Basic auth'
  const started = Date.now()

  try {
    const res = await client.kibana('GET', '/api/detection_engine/rules/_find', { query: { per_page: 1 } })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Elastic rejected the credential (HTTP ${res.status}). Check the API key and its privileges for the Detections API.`,
        details: [`Kibana: ${kibanaUrl}`, `Auth: ${authLabel}`],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Kibana Detections API was not found (404) at ${kibanaUrl}. Check the Kibana base URL.`,
        details: [`Kibana: ${kibanaUrl}`],
        latencyMs,
      }
    }
    if (res.ok) {
      return {
        ok: true,
        message: `Connected to Elastic Security (Kibana) at ${kibanaUrl}.`,
        details: [`Kibana: ${kibanaUrl}`, `Auth: ${authLabel}`, 'Probe: GET /api/detection_engine/rules/_find'],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `Kibana returned HTTP ${res.status}.`,
      details: [`Kibana: ${kibanaUrl}`, `Response: ${elasticErrorMessage(res).slice(0, 200)}`],
      latencyMs,
    }
  } catch (err) {
    return {
      ok: false,
      message: classifyNetworkError(err, kibanaUrl),
      details: [`Kibana: ${kibanaUrl}`, `Auth: ${authLabel}`],
      latencyMs: Date.now() - started,
    }
  }
}
