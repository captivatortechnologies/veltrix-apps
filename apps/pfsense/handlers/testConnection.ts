import type { ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, pfsenseErrorMessage, readPfsenseSettings } from '../lib/pfsenseApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever SDK the platform resolves.
interface TestConnectionContext {
  appId: string
  customerId: string
  endpoint: string | null
  credential: CredentialRef | null
  component: { hostname?: string | null; port?: string | number | null } | null
  connectivity: unknown
  settings: Record<string, unknown>
}
interface TestConnectionResult {
  ok: boolean
  message: string
  details?: string[]
  latencyMs?: number
}

const DEFAULT_TEST_PORT = 443

/** Build a synthetic ComponentRef from the connection's endpoint/port, for a connection under test (no registered Component yet). */
function resolveTestComponent(ctx: TestConnectionContext): ComponentRef | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    const port = url.port || String(ctx.component?.port ?? '').trim() || String(DEFAULT_TEST_PORT)
    return { id: 'test-connection', hostname: url.hostname, port, type: ['pfsense'], toolId: 'pfsense' }
  } catch {
    return null
  }
}

// =============================================================================
// pfSense — connection test.
//
// Verifies a Connection's endpoint + credential against the REST API package:
// authenticate (a no-op for API-key mode; mints a JWT for username/password
// mode) then GET /api/v2/system/version — a 200 confirms the package is
// installed AND reachable AND the credential is accepted; a 401/403 proves
// the package is reachable but flags the credential; a connection refused or
// 404 on EVERY path usually means the REST API package is not installed on
// this pfSense box (a real, separate install step — see the Setup Guide and
// lib/pfsenseApi.ts's module doc). See lib/pfsenseApi.ts for API references.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const component = resolveTestComponent(ctx)
  if (!component) {
    return { ok: false, message: 'No endpoint is configured for this connection. Set the pfSense firewall hostname (and HTTPS port, default 443).' }
  }
  if (!hasUsableCredential(ctx.credential)) {
    return {
      ok: false,
      message:
        'No usable pfSense credential — attach either an API key or a local webConfigurator administrator username + password to this connection.',
    }
  }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, null, ctx.credential, settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client, host } = built

  const details = [`Endpoint: https://${host}:${component.port}${settings.apiBasePath}`]
  const started = Date.now()

  const auth = await client.authenticate()
  if (auth.error) {
    const latencyMs = Date.now() - started
    if (/HTTP 404/.test(auth.error)) {
      return {
        ok: false,
        message: `${auth.error} — is the pfSense REST API package (pfSense-pkg-RESTAPI) installed on this box? See the Setup Guide.`,
        details,
        latencyMs,
      }
    }
    return { ok: false, message: auth.error, details, latencyMs }
  }

  try {
    const res = await client.getSystemVersion()
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached pfSense but authentication failed (HTTP ${res.status}). Check the credential.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message:
          `HTTP 404 from ${details[0]} — the pfSense REST API package (pfSense-pkg-RESTAPI) does not appear ` +
          'to be installed on this box. Install it via System > Package Manager > Available Packages before ' +
          'retrying. See the Setup Guide.',
        details,
        latencyMs,
      }
    }
    if (!res.ok) {
      return { ok: false, message: `pfSense rejected the request (HTTP ${res.status}): ${pfsenseErrorMessage(res)}`, details, latencyMs }
    }
    return { ok: true, message: `Connected to the pfSense REST API package on ${host}.`, details, latencyMs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out reaching ${details[0]}: ${msg}`, details, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${details[0]}.`, details, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${host}. Check the port (default 443).`, details, latencyMs }
    if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) {
      return {
        ok: false,
        message: `TLS/certificate error reaching ${host}: ${msg}. Turn off "Verify TLS certificate" in settings if pfSense is using its default self-signed certificate.`,
        details,
        latencyMs,
      }
    }
    return { ok: false, message: `Could not reach ${host}: ${msg}`, details, latencyMs }
  }
}
