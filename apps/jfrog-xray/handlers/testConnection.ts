import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildXrayClient, MISSING_CREDENTIAL_MESSAGE, resolveXrayToken, xrayErrorMessage } from '../lib/xrayApi'

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

const POLICIES_PATH = '/api/v2/policies'

// =============================================================================
// JFrog Xray — connection test.
//
// Verifies a Connection with an AUTHENTICATED call — `GET /xray/api/v2/policies`
// — rather than the unauthenticated `GET /xray/api/v1/system/ping` health check.
// Xray's ping proves only that the service is up; it does not exercise the
// Bearer token at all, so it cannot tell an operator whether their Access Token
// is valid or scoped correctly. A successful policies list proves the host
// resolves, the token authenticates, and it carries at least the Read Policies
// permission this app needs for every operation.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set the JFrog Platform host (e.g. mycompany.jfrog.io).',
    }
  }
  if (!resolveXrayToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildXrayClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client } = built
  const details = [`Endpoint: ${client.baseUrl}${POLICIES_PATH}`, 'Auth: JFrog Platform Access Token (Bearer)']
  const started = Date.now()

  try {
    const res = await client.request('GET', POLICIES_PATH)
    const latencyMs = Date.now() - started

    if (res.status === 401) {
      return { ok: false, message: 'JFrog rejected the Access Token (HTTP 401) — it may be expired, revoked, or malformed.', details, latencyMs }
    }
    if (res.status === 403) {
      return {
        ok: false,
        message: 'Authenticated with JFrog, but the Access Token is missing the Xray "Read Policies" permission.',
        details,
        latencyMs,
      }
    }
    if (!res.ok) {
      return { ok: false, message: `JFrog Xray returned HTTP ${res.status}: ${xrayErrorMessage(res)}`, details, latencyMs }
    }
    return { ok: true, message: `Connected to JFrog Xray (${client.baseUrl}).`, details, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: classifyTransportError(msg, client.baseUrl), details, latencyMs }
  }
}

/** Turn a transport-level error into an operator-actionable message. */
function classifyTransportError(message: string, baseUrl: string): string {
  if (/timed?\s?out/i.test(message)) {
    return `Timed out reaching JFrog Xray at ${baseUrl}. Check the host and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) {
    return `Could not resolve ${baseUrl}. Check the JFrog Platform host.`
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `Connection refused by ${baseUrl}.`
  }
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(message)) {
    return `TLS/certificate error reaching ${baseUrl}: ${message}`
  }
  return `Could not reach JFrog Xray (${baseUrl}): ${message}`
}
