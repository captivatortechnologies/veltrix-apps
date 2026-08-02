import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildHackeroneClient,
  hackeroneErrorMessage,
  resolveHackeroneAuth,
  MISSING_CREDENTIAL_MESSAGE,
  HACKERONE_BASE_URL,
} from '../lib/hackeroneApi'

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
// HackerOne — connection test.
//
// Verifies a Connection with a single authenticated request against the fixed API
// host: GET https://api.hackerone.com/v1/me/programs?page[size]=1. It proves the
// API is reachable and the Basic-auth pair (API identifier + token) is valid.
// Runs in-process with the decrypted credential.
// =============================================================================

function classifyProbeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching HackerOne at ${HACKERONE_BASE_URL}. Check network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve the HackerOne API host (${HACKERONE_BASE_URL}).`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${HACKERONE_BASE_URL}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${HACKERONE_BASE_URL}: ${msg}.`
  return `Could not reach HackerOne (${HACKERONE_BASE_URL}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveHackeroneAuth(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildHackeroneClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built
  const details = [`API host: ${baseUrl}`, 'Auth: HTTP Basic (API identifier + token)']
  const started = Date.now()

  try {
    const res = await client.health()
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `HackerOne rejected the credential (HTTP ${res.status}). Check the API token identifier (username) and token value.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to HackerOne (${baseUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `HackerOne API returned HTTP ${res.status}: ${hackeroneErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err), details, latencyMs: Date.now() - started }
  }
}
