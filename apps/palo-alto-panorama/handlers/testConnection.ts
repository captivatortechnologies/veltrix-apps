import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildPanoramaClient,
  locationLabel,
  panoramaErrorMessage,
  resolvePanoramaApiKey,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/panorama'

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
// Palo Alto Panorama — connection test.
//
// Verifies a Connection with a single authenticated REST GET of
// /restapi/<version>/Objects/Addresses at the configured location. It proves the
// Panorama host is reachable and the API key (X-PAN-KEY) is valid. Runs
// in-process with the decrypted credential.
// =============================================================================

const PROBE_PATH = '/Objects/Addresses'

function classifyProbeError(err: unknown, panoramaUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Panorama at ${panoramaUrl}. Check the host and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${panoramaUrl}. Check the Panorama management host.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${panoramaUrl}. Check that Panorama is reachable over HTTPS (443).`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) {
    return `TLS/certificate error reaching ${panoramaUrl}: ${msg}. Panorama's management certificate (often self-signed) must be trusted by the platform host.`
  }
  return `Could not reach Panorama (${panoramaUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set the Panorama management host (e.g. panorama.example.com).',
    }
  }
  if (!resolvePanoramaApiKey(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildPanoramaClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, panoramaUrl, location } = built
  const details = [`Panorama: ${panoramaUrl}`, `Location: ${locationLabel(location)}`, 'Auth: X-PAN-KEY (API key)']
  const started = Date.now()

  try {
    const res = await client.list(PROBE_PATH)
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Panorama rejected the API key (HTTP ${res.status}). Regenerate the key with type=keygen and check the admin role scope.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `PAN-OS REST API not found (404) at ${panoramaUrl}. Check the rest_api_version setting — PAN-OS 11.1 serves /restapi/v11.0, not v11.1.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Palo Alto Panorama (${panoramaUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Panorama REST API returned HTTP ${res.status}: ${panoramaErrorMessage({ status: res.status, ok: false, body: res.body })}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, panoramaUrl), details, latencyMs: Date.now() - started }
  }
}
