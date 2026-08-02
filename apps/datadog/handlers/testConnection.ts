import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, MISSING_CREDENTIAL_MESSAGE, resolveDatadogKeys } from '../lib/datadogApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves at load time.
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
// Datadog — connection test.
//
// Verifies a Connection's site + API key with GET /api/v1/validate — the
// endpoint Datadog documents specifically for this purpose. It requires only
// DD-API-KEY (no Application key):
//   https://docs.datadoghq.com/api/latest/authentication/validate-api-key/
//   200 { "valid": true }  |  403 { "errors": ["Bad Request"] } (invalid key)
// This app also requires an Application key for the Security Monitoring Rules
// API it manages, so a missing Application key still fails the test here (the
// connection would not be usable for a deploy otherwise) even though this
// specific probe would not need it.
// =============================================================================

const TIMEOUT_MS = 10_000

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const site = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!site) {
    return { ok: false, message: 'No Datadog site is configured for this connection (e.g. "datadoghq.com", "datadoghq.eu").' }
  }

  if (!resolveDatadogKeys(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildDatadogClient(site, ctx.credential, { ...ctx.settings, request_timeout_seconds: TIMEOUT_MS / 1000 })
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built
  const details = [`Site: ${baseUrl.replace(/^https:\/\/api\./, '')}`, 'Auth: DD-API-KEY + DD-APPLICATION-KEY']
  const started = Date.now()

  const res = await client.request('GET', '/api/v1/validate')
  const latencyMs = Date.now() - started

  if (res.status === 0) {
    return { ok: false, message: classifyTransportError(res.body, baseUrl), details, latencyMs }
  }
  if (res.status === 403 || res.status === 401) {
    return {
      ok: false,
      message: `Datadog rejected the API key (HTTP ${res.status}): ${datadogErrorMessage(res)}`,
      details,
      latencyMs,
    }
  }
  if (!res.ok) {
    return { ok: false, message: `Datadog returned HTTP ${res.status}: ${datadogErrorMessage(res)}`, details, latencyMs }
  }

  return { ok: true, message: `Connected to Datadog (${baseUrl}).`, details, latencyMs }
}

/** Turn a transport-level failure (network/timeout/DNS) into an operator-actionable message. */
function classifyTransportError(message: string, baseUrl: string): string {
  if (/timed?\s?out/i.test(message)) {
    return `Timed out reaching Datadog at ${baseUrl}. Check the site value and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) {
    return `Could not resolve ${baseUrl}. Check the Datadog site (e.g. "datadoghq.com", "datadoghq.eu", "us3.datadoghq.com").`
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `Connection refused by ${baseUrl}.`
  }
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(message)) {
    return `TLS/certificate error reaching ${baseUrl}: ${message}`
  }
  return `Could not reach Datadog (${baseUrl}): ${message}`
}
