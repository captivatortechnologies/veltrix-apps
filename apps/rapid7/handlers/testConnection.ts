import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  resolveInsightVMCredentials,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/insightvm'
import {
  buildInsightIDRClient,
  insightIDRErrorMessage,
  resolveInsightIDRCredential,
  INSIGHTIDR_REGIONS,
  MISSING_CREDENTIAL_MESSAGE as MISSING_IDR_CREDENTIAL_MESSAGE,
} from '../lib/insightidr'

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
// Rapid7 — connection test.
//
// The app spans two Rapid7 APIs, so the test is chosen from the connection's
// endpoint:
//   - InsightIDR (Insight Platform cloud): a host like us.api.insight.rapid7.com
//     or a bare region code — verified with GET /validate + X-Api-Key.
//   - InsightVM (on-prem Security Console): any other host:3780 — verified with
//     GET /sites?size=1 + Basic auth.
// Runs in-process with the decrypted credential.
// =============================================================================

const IDR_PROBE_PATH = '/validate'
const VM_PROBE_PATH = '/sites'

/** True when the endpoint targets the InsightIDR (Insight Platform) cloud. */
function isInsightIDRHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')
  if (h.includes('insight.rapid7.com')) return true
  return (INSIGHTIDR_REGIONS as readonly string[]).includes(h)
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message:
        'No endpoint is configured for this connection. Set the InsightVM Security Console host ' +
        '(e.g. console.example.com:3780) or the InsightIDR region host (e.g. us.api.insight.rapid7.com).',
    }
  }

  return isInsightIDRHost(host)
    ? testInsightIDR(host, ctx)
    : testInsightVM(host, ctx)
}

async function testInsightIDR(host: string, ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveInsightIDRCredential(ctx.credential)) {
    return { ok: false, message: MISSING_IDR_CREDENTIAL_MESSAGE }
  }
  const built = buildInsightIDRClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl, region } = built
  const details = [`InsightIDR: ${baseUrl}`, `Region: ${region}`, 'Auth: X-Api-Key']
  const started = Date.now()

  try {
    const res = await client.request('GET', IDR_PROBE_PATH)
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `InsightIDR rejected the API key (HTTP ${res.status}). Check the key and that its region matches ${region}.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Rapid7 InsightIDR (${baseUrl}).`, details, latencyMs }
    }
    return { ok: false, message: `InsightIDR API returned HTTP ${res.status}: ${insightIDRErrorMessage(res)}`, details, latencyMs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Could not reach InsightIDR (${baseUrl}): ${msg}`, details, latencyMs: Date.now() - started }
  }
}

async function testInsightVM(host: string, ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveInsightVMCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }
  const built = buildInsightVMClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, consoleUrl } = built
  const details = [`Console: ${consoleUrl}`, 'Auth: HTTP Basic']
  const started = Date.now()

  try {
    const res = await client.request('GET', VM_PROBE_PATH, { query: { page: 0, size: 1 } })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `InsightVM rejected the credential (HTTP ${res.status}). Check the console username/password and that the account has the required role. For a 2FA account, set the 2FA Token app setting.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `InsightVM v3 API not found (404) at ${consoleUrl}. Check the console host:port.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Rapid7 InsightVM (${consoleUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `InsightVM API returned HTTP ${res.status}: ${insightVMErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, consoleUrl), details, latencyMs: Date.now() - started }
  }
}

function classifyProbeError(err: unknown, consoleUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching the InsightVM console at ${consoleUrl}. Check the console host:port and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${consoleUrl}. Check the console host.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${consoleUrl}. Check the console is running and the port (3780).`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) {
    return `TLS/certificate error reaching ${consoleUrl}: ${msg}. The console's self-signed certificate must be trusted by the platform host.`
  }
  return `Could not reach the InsightVM console (${consoleUrl}): ${msg}`
}
