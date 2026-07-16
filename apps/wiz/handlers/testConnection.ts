import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildWizClient, resolveWizCredentials, MISSING_CREDENTIAL_MESSAGE } from '../lib/wiz'

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
// Wiz — connection test.
//
// Verifies a Connection with a single trivial authenticated GraphQL query
// (`{ __typename }`) against the tenant's regional API endpoint. It proves the
// endpoint is reachable, the OAuth2 client-credentials exchange succeeds, and
// the resulting Bearer token is accepted. Runs in-process with the decrypted
// credential.
// =============================================================================

const PROBE_QUERY = `query { __typename }`

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set the regional Wiz API host (e.g. api.us17.app.wiz.io).',
    }
  }
  if (!resolveWizCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildWizClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, graphqlUrl } = built
  const details = [`Endpoint: ${graphqlUrl}`, 'Auth: OAuth2 client credentials']
  const started = Date.now()

  try {
    const res = await client.graphql<{ __typename?: string }>(PROBE_QUERY)
    const latencyMs = Date.now() - started

    if (res.transportError) {
      return { ok: false, message: classifyTransportError(res.transportError, res.status, graphqlUrl), details, latencyMs }
    }
    if (res.errors) {
      // Authenticated and reachable, but the probe query itself was rejected.
      return {
        ok: false,
        message: `Reached Wiz but the probe query was rejected: ${res.errors.map((e) => e.message || 'error').join('; ')}`,
        details,
        latencyMs,
      }
    }
    return { ok: true, message: `Connected to Wiz (${graphqlUrl}).`, details, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    return { ok: false, message: classifyTransportError(err instanceof Error ? err.message : String(err), 0, graphqlUrl), details, latencyMs }
  }
}

/** Turn a transport-level error into an operator-actionable message. */
function classifyTransportError(message: string, status: number, graphqlUrl: string): string {
  if (/token request failed/i.test(message)) {
    return `Wiz rejected the client credentials — check the Client ID (username) and Client Secret (API token), and that the service account is enabled. (${message})`
  }
  if (status === 401 || status === 403 || /HTTP 40[13]\b/.test(message)) {
    return `Wiz rejected the access token (HTTP ${status || '401/403'}). The credentials authenticated but the token was not accepted — verify the tenant/audience.`
  }
  if (status === 404 || /HTTP 404\b/.test(message)) {
    return `Wiz API endpoint not found (404) at ${graphqlUrl}. Check the regional API host (e.g. api.us17.app.wiz.io).`
  }
  if (/abort|timed?\s?out/i.test(message)) {
    return `Timed out reaching Wiz at ${graphqlUrl}. Check the endpoint and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) {
    return `Could not resolve ${graphqlUrl}. Check the regional API host.`
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `Connection refused by ${graphqlUrl}.`
  }
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(message)) {
    return `TLS/certificate error reaching ${graphqlUrl}: ${message}`
  }
  return `Could not reach Wiz (${graphqlUrl}): ${message}`
}
