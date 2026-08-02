import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, resolveTwingateCredentials, MISSING_CREDENTIAL_MESSAGE } from '../lib/twingateApi'

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
// Twingate — connection test.
//
// Verifies a Connection with the minimal authenticated GraphQL query documented
// at https://www.twingate.com/docs/api-overview:
//   { remoteNetworks(first:1){edges{node{id}}} }
// It proves the network host is reachable and the X-API-KEY is accepted. Runs
// in-process with the decrypted credential.
// =============================================================================

const PROBE_QUERY = `{ remoteNetworks(first: 1) { edges { node { id } } } }`

interface ProbeResult {
  remoteNetworks?: { edges?: Array<{ node?: { id?: string } }> }
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set your Twingate network name (e.g. "acme" or "acme.twingate.com").',
    }
  }
  if (!resolveTwingateCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildTwingateClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, graphqlUrl } = built
  const details = [`Endpoint: ${graphqlUrl}`, 'Auth: X-API-KEY']
  const started = Date.now()

  try {
    const res = await client.graphql<ProbeResult>(PROBE_QUERY)
    const latencyMs = Date.now() - started

    if (res.transportError) {
      return { ok: false, message: classifyTransportError(res.transportError, res.status, graphqlUrl), details, latencyMs }
    }
    if (res.errors) {
      return {
        ok: false,
        message: `Reached Twingate but the probe query was rejected: ${res.errors.map((e) => e.message || 'error').join('; ')}`,
        details,
        latencyMs,
      }
    }
    return { ok: true, message: `Connected to Twingate (${graphqlUrl}).`, details, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    return { ok: false, message: classifyTransportError(err instanceof Error ? err.message : String(err), 0, graphqlUrl), details, latencyMs }
  }
}

/** Turn a transport-level error into an operator-actionable message. */
function classifyTransportError(message: string, status: number, graphqlUrl: string): string {
  if (status === 401 || status === 403 || /HTTP 40[13]\b/.test(message)) {
    return `Twingate rejected the API key (HTTP ${status || '401/403'}). Generate a new token in Settings > API and verify it is stored in the connection's "API token" field. (${message})`
  }
  if (status === 404 || /HTTP 404\b/.test(message)) {
    return `Twingate network not found (404) at ${graphqlUrl}. Check the network name (e.g. "acme" or "acme.twingate.com").`
  }
  if (status === 429 || /HTTP 429\b/.test(message)) {
    return `Twingate rate-limited this request (HTTP 429). Twingate allows 60 reads / 20 writes per minute by default — try again shortly.`
  }
  if (/abort|timed?\s?out/i.test(message)) {
    return `Timed out reaching Twingate at ${graphqlUrl}. Check the network name and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) {
    return `Could not resolve ${graphqlUrl}. Check the network name.`
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `Connection refused by ${graphqlUrl}.`
  }
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(message)) {
    return `TLS/certificate error reaching ${graphqlUrl}: ${message}`
  }
  return `Could not reach Twingate (${graphqlUrl}): ${message}`
}
