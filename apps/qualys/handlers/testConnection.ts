import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildQualysClient,
  qualysErrorMessage,
  resolveQualysCredentials,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/qualys'

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
// Qualys — connection test.
//
// Verifies a Connection with a single authenticated request against the classic
// v2 API: GET /api/2.0/fo/asset/group/?action=list&truncation_limit=1. It proves
// the platform URL is reachable and the Basic-auth username/password are valid.
// Runs in-process with the decrypted credential.
// =============================================================================

const PROBE_PATH = '/api/2.0/fo/asset/group/'

function classifyProbeError(err: unknown, platformUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Qualys at ${platformUrl}. Check the platform URL and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${platformUrl}. Check the Qualys platform URL (Help > About).`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${platformUrl}. Check the Qualys platform URL.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) {
    return `TLS/certificate error reaching ${platformUrl}: ${msg}.`
  }
  return `Could not reach Qualys (${platformUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message:
        'No endpoint is configured for this connection. Set the Qualys platform URL (e.g. ' +
        'qualysapi.qg2.apps.qualys.com) on the connection.',
    }
  }
  if (!resolveQualysCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildQualysClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, platformUrl } = built
  const details = [`Platform: ${platformUrl}`, 'Auth: HTTP Basic + X-Requested-With']
  const started = Date.now()

  try {
    const res = await client.post(PROBE_PATH, { action: 'list', truncation_limit: 1 })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Qualys rejected the credential (HTTP ${res.status}). Check the account username/password and that API access is enabled for the account.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 409) {
      return {
        ok: false,
        message: 'Qualys returned HTTP 409 (rate / concurrency limit). The credential is valid — retry shortly.',
        details,
        latencyMs,
      }
    }
    if (res.status === 400 && /X-Requested-With/i.test(res.body)) {
      return { ok: false, message: 'Qualys rejected the request (missing X-Requested-With). This is a client bug — please report it.', details, latencyMs }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Qualys (${platformUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Qualys API returned HTTP ${res.status}: ${qualysErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, platformUrl), details, latencyMs: Date.now() - started }
  }
}
