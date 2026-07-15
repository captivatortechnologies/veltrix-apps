import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  resolveFalconCredentials,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/falcon'

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
// CrowdStrike Falcon — connection test.
//
// Verifies a Connection by running the OAuth2 client-credentials handshake
// (POST /oauth2/token with the credential's client ID + secret) and then a
// single lightweight authenticated GET (`/devices/queries/host-groups/v1`).
// The token exchange proves the client ID/secret are valid; the GET proves the
// resolved cloud endpoint is reachable and the client carries API scope. Both
// steps run inside FalconClient.request, so this is one authenticated probe.
// Runs in-process on the platform with the decrypted credential.
// =============================================================================

// Lightweight authenticated probe — a bounded host-group query. Mirrors the
// reachability check the config-type health checks use.
const PROBE_PATH = '/devices/queries/host-groups/v1'

function classifyProbeError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  // FalconClient throws this when the OAuth2 token exchange is rejected — the
  // client ID/secret are wrong, or the credential targets the wrong cloud.
  if (/authentication failed/i.test(msg)) {
    return 'Falcon rejected the API client credentials. Check the client ID/secret and that the credential targets the right cloud region.'
  }
  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching the Falcon API at ${baseUrl}. Check the endpoint and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${baseUrl}. Check the endpoint / cloud region.`
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) {
    return `TLS/certificate error reaching ${baseUrl}: ${msg}`
  }
  return `Could not reach the Falcon API (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set the Falcon API endpoint (or cloud region) on the connection.',
    }
  }

  if (!resolveFalconCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildFalconClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built
  const details = [`Endpoint: ${baseUrl}`, 'Auth: OAuth2 API client']
  const started = Date.now()

  try {
    const res = await client.request('GET', PROBE_PATH, { query: { limit: 1 } })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Falcon rejected the API client (HTTP ${res.status}). Check the client ID/secret and that the client has the required API scopes.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Falcon API endpoint not found (404) at ${baseUrl}. Check the endpoint / cloud region.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return {
        ok: true,
        message: `Connected to CrowdStrike Falcon (${baseUrl}).`,
        details,
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `Falcon API returned HTTP ${res.status}: ${falconErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return {
      ok: false,
      message: classifyProbeError(err, baseUrl),
      details,
      latencyMs: Date.now() - started,
    }
  }
}
