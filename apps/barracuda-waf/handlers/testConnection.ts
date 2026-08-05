import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildBarracudaClient,
  classifyNetworkError,
  barracudaErrorMessage,
  readBarracudaSettings,
  resolveBarracudaCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/barracudaWaf'

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
// Barracuda WAF-as-a-Service — connection test.
//
// Verifies a Connection by logging in (POST /api_login/) with the stored
// admin email/password — this proves the Barracuda Cloud Control credentials
// are valid regardless of which Application they can reach. When the
// connection is paired with a component (whose hostname is a WAF-as-a-Service
// Application name), it additionally verifies that specific Application is
// visible to this account (GET /applications/{appName}/basic_security/).
// Runs in-process with the decrypted credential.
// =============================================================================

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const cred = resolveBarracudaCredential(ctx.credential)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const { baseUrl } = readBarracudaSettings(ctx.settings)
  const hostname = (ctx.component?.hostname || '').trim()
  const details = [`API: ${baseUrl}`, `Admin: ${cred.email}`]
  const started = Date.now()

  // Login always runs first (proves the credential itself), regardless of
  // whether a target Application is registered yet.
  const probe = buildBarracudaClient(hostname || 'login-probe', ctx.credential, ctx.settings)
  if ('error' in probe) return { ok: false, message: probe.error, details }
  const { client } = probe

  try {
    const listRes = await client.request('GET', '/applications/')
    const latencyMs = Date.now() - started

    if (listRes.status === 401 || listRes.status === 403) {
      return {
        ok: false,
        message: `Barracuda rejected the admin credentials (HTTP ${listRes.status}). Check the email/password and, if this is an MSP account, the Account ID setting.`,
        details,
        latencyMs,
      }
    }
    if (!listRes.ok) {
      return { ok: false, message: `Barracuda WAF-as-a-Service API returned HTTP ${listRes.status}: ${barracudaErrorMessage(listRes)}`, details, latencyMs }
    }

    if (!hostname) {
      return {
        ok: true,
        message: 'Connected to Barracuda WAF-as-a-Service — credentials verified. Register a component (hostname = an Application name) to also verify a specific Application.',
        details,
        latencyMs,
      }
    }

    const appRes = await client.request('GET', `${client.appPath(hostname)}/basic_security/`)
    const totalLatencyMs = Date.now() - started
    if (appRes.status === 404) {
      return {
        ok: false,
        message: `Application "${hostname}" was not found (404). Check the component hostname matches an Application name exactly as shown in the WAF-as-a-Service console.`,
        details,
        latencyMs: totalLatencyMs,
      }
    }
    if (!appRes.ok) {
      return { ok: false, message: `Barracuda WAF-as-a-Service API returned HTTP ${appRes.status} for Application "${hostname}": ${barracudaErrorMessage(appRes)}`, details, latencyMs: totalLatencyMs }
    }

    return {
      ok: true,
      message: `Connected to Barracuda WAF-as-a-Service — Application "${hostname}".`,
      details: [...details, `Application: ${hostname}`],
      latencyMs: totalLatencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyNetworkError(err, baseUrl), details, latencyMs: Date.now() - started }
  }
}
