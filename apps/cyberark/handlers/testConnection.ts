import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildCyberArkClient,
  cyberArkErrorMessage,
  readCyberArkSettings,
  resolveCyberArkCredentials,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/cyberark'

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
// CyberArk PVWA — connection test.
//
// Runs the logon flow (POST /auth/{method}/Logon) then a lightweight authorized
// probe (GET /Safes?limit=1) against the PVWA REST API. Proves the PVWA host is
// reachable and the manager credential + auth method are valid. Runs in-process
// with the decrypted credential; the session is released afterwards.
// =============================================================================

const PROBE_PATH = '/Safes'

function classifyProbeError(err: unknown, pvwaUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching CyberArk PVWA at ${pvwaUrl}. Check the PVWA host and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${pvwaUrl}. Check the PVWA host.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${pvwaUrl}. Check that the PVWA web server is running and reachable.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) {
    return `TLS/certificate error reaching ${pvwaUrl}: ${msg}. The PVWA certificate must be trusted by the platform host.`
  }
  return `Could not reach CyberArk PVWA (${pvwaUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set the PVWA host (e.g. pvwa.example.com) on the connection.',
    }
  }
  if (!resolveCyberArkCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildCyberArkClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, pvwaUrl } = built
  const { authMethod } = readCyberArkSettings(ctx.settings)
  const details = [`PVWA: ${pvwaUrl}`, `Auth method: ${authMethod}`]
  const started = Date.now()

  try {
    // Step 1 — logon (validates credential + auth method).
    const session = await client.ensureSession()
    if (!session.ok) {
      return {
        ok: false,
        message: `CyberArk rejected the logon: ${session.error}. Check the manager username/password and that the auth method (${authMethod}) matches the account.`,
        details,
        latencyMs: Date.now() - started,
      }
    }

    // Step 2 — lightweight authorized probe.
    const res = await client.request('GET', PROBE_PATH, { query: { limit: 1 } })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `CyberArk authorized the logon but rejected the probe (HTTP ${res.status}). The account may lack Vault authorizations to list safes.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `PVWA REST API not found (404) at ${pvwaUrl}/API. Check the PVWA host and that /PasswordVault is deployed.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to CyberArk PVWA (${pvwaUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `CyberArk PVWA returned HTTP ${res.status}: ${cyberArkErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, pvwaUrl), details, latencyMs: Date.now() - started }
  } finally {
    await client.logoff()
  }
}
