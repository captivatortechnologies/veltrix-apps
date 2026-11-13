import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'
import { buildAuthHeader, buildSplunkUrl, hasSplunkAddress, splunkFetch } from '../lib/splunkApi'

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
  component: { hostname?: string | null; port?: string | null } | null
  connectivity: unknown
  connectivityProvider?: { config?: Record<string, unknown> | null } | null
  settings: Record<string, unknown>
}
interface TestConnectionResult {
  ok: boolean
  message: string
  details?: string[]
  latencyMs?: number
}

// =============================================================================
// Splunk Enterprise — connection test.
//
// Verifies a Connection's endpoint + credential by hitting the Splunk management
// API's `/services/server/info` (the same reachability probe the health checks
// use). A 200 confirms the endpoint is reachable AND the credential authenticates.
// Runs in-process on the platform with the decrypted credential.
// =============================================================================

const TIMEOUT_MS = 10_000

function classifyNetworkError(err: unknown, base: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}. Check the host/port and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve the host in ${base}. Check the endpoint.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${base}. Check the port and that Splunk is listening.`
  if (/certificate|self.signed|CERT_|SSL|TLS/i.test(msg)) return `TLS error reaching ${base}: ${msg}`
  return `Could not reach ${base}: ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const started = Date.now()
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }
  const component = { hostname: ctx.endpoint || ctx.component?.hostname || '', port: ctx.component?.port || String(ctx.settings.splunk_api_port || 8089) } as ComponentRef
  const connectivity = ctx.connectivity as ConnectivityRef | null
  if (!hasSplunkAddress(component, connectivity, ctx.connectivityProvider)) return { ok: false, message: 'No endpoint is configured for this connection.' }
  let base = ''
  const authType = ctx.credential.apiToken?.trim() ? 'Splunk authentication token' : 'username & password'
  try {
    base = buildSplunkUrl(component, connectivity, ctx.connectivityProvider)
    const headers = buildAuthHeader(ctx.credential)
    const res = await splunkFetch(`${base}/services/server/info?output_mode=json`, { method: 'GET', headers, timeoutMs: TIMEOUT_MS })
    const details = [`Endpoint: ${base}`, `Auth: ${authType}`]
    const latencyMs = Date.now() - started
    if (res.status === 401) return { ok: false, message: 'Authentication failed (401). Check token expiry, token authentication, or username/password. HEC ingestion tokens cannot authenticate to the management API.', details, latencyMs }
    if (res.status === 403) return { ok: false, message: 'Access denied (403). The Splunk account needs permission to read server information; check its role capabilities.', details, latencyMs }
    if (res.status >= 300 && res.status < 400) return { ok: false, message: 'The endpoint redirected. Use the direct splunkd management URL (usually HTTPS port 8089), not Splunk Web, HEC or an SSO login page.', details, latencyMs }
    if (!res.ok) return { ok: false, message: `Splunk returned HTTP ${res.status}.`, details, latencyMs }
    let version: unknown
    try { version = JSON.parse(await res.text())?.entry?.[0]?.content?.version } catch { /* report a wrong endpoint below */ }
    if (typeof version !== 'string' || !version.trim()) return { ok: false, message: 'The endpoint did not return Splunk server information. Use the management API on port 8089, not Splunk Web (8000) or HEC (8088).', details, latencyMs }
    return { ok: true, message: `Connected to Splunk ${version}.`, details: [...details, `Version: ${version}`, 'Test confirms management read access only; deploy permissions and cluster bundle distribution require separate checks.'], latencyMs }
  } catch (err) {
    return { ok: false, message: base ? classifyNetworkError(err, base) : (err instanceof Error ? err.message : 'Invalid management endpoint'), details: base ? [`Endpoint: ${base}`, `Auth: ${authType}`] : undefined, latencyMs: Date.now() - started }
  }
}
