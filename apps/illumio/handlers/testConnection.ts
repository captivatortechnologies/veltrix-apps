import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  readIllumioSettings,
  resolveIllumioCredential,
  buildIllumioBaseUrl,
  orgPath,
  basicAuthHeader,
  illumioRequest,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/illumioApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever @veltrixsecops/app-sdk
// version the platform resolves at load time. Only long-standing types
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
// Illumio PCE — connection test.
//
// The PCE host, port and org id are app SETTINGS (a Veltrix installation
// manages one PCE), so this ignores the connection's own `endpoint` field and
// reads ctx.settings directly — same posture as this repo's other on-prem,
// settings-scoped apps (e.g. FortiManager). Verifies the credential + settings
// with a single authenticated GET /orgs/{org_id}/labels?max_results=1, which
// proves host reachability, TLS trust, Basic auth AND org access at once.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) {
    return {
      ok: false,
      message: 'No PCE host is configured. Set the "PCE host" (and optionally port / organization ID) app settings.',
    }
  }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const details = [`PCE: ${base}`, `Org: ${settings.orgId}`, `API key: ${cred.key}`, 'Auth: HTTP Basic']
  const started = Date.now()
  try {
    const res = await illumioRequest(`${base}${orgPath(settings, 'labels')}?max_results=1`, {
      headers,
      timeoutMs: settings.timeoutMs,
      verifyTls: settings.verifyTls,
    })
    const latencyMs = Date.now() - started

    if (res.ok) {
      return { ok: true, message: `Connected to the Illumio PCE (org ${settings.orgId}).`, details, latencyMs }
    }
    return { ok: false, message: classifyFailure(res.status, res.body, settings.orgId, base), details, latencyMs }
  } catch (error) {
    const latencyMs = Date.now() - started
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: classifyTransportError(message, base), details, latencyMs }
  }
}

/** Turn a transport-level (node:https) failure into an operator-actionable message. */
function classifyTransportError(message: string, base: string): string {
  if (/abort|timed?\s?out/i.test(message)) return `Timed out reaching the PCE at ${base}.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) return `Could not resolve the host in ${base}. Check the "PCE host" setting.`
  if (/ECONNREFUSED/i.test(message)) return `Connection refused by ${base}. Check the "PCE port" setting and that the PCE is listening.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(message)) {
    return `TLS/certificate error reaching ${base}: ${message}. Turn off "Verify TLS certificate" if the PCE uses a self-signed or internal-CA certificate.`
  }
  return `Could not reach the PCE at ${base}: ${message}`
}

/** Turn an HTTP failure into an operator-actionable message. */
function classifyFailure(status: number, body: string, orgId: number, base: string): string {
  if (status === 401) {
    return 'The PCE rejected the API key/secret (HTTP 401). Verify the credential username is the API key ' +
      '(e.g. api_145a5c788e2ba897c) and the secret matches, and that the key is enabled.'
  }
  if (status === 403) {
    return `The API key was accepted but is not authorized for org ${orgId} (HTTP 403). Check the key's ` +
      'scope/permissions and the "Organization ID" setting.'
  }
  if (status === 404) {
    return `Organization ${orgId} was not found (HTTP 404) at ${base}. Check the "Organization ID" setting.`
  }
  if (status === 0) {
    return `Could not reach the PCE at ${base}. Check the host, port, network reachability and the ` +
      '"Verify TLS certificate" setting.'
  }
  return `The PCE returned HTTP ${status}: ${body.slice(0, 200)}`
}
