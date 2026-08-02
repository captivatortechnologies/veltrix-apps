import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { iseRequest, buildAuthHeader, hasUsableCredential, ersErrorMessage, readIseSettings, DEFAULT_ERS_PORT } from '../lib/iseApi'

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

const TIMEOUT_MS = 10_000

/**
 * Normalize a raw endpoint/host into `https://<host>:<port>` — no trailing
 * slash, no `/ers/config` suffix. Honours an explicit port on the endpoint
 * (`ise-pan.example.com:9060`); otherwise falls back to the resolved
 * component's port, then the fixed ERS default (9060).
 */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    const port = url.port || String(ctx.component?.port ?? '').trim() || String(DEFAULT_ERS_PORT)
    return `https://${url.hostname}:${port}`
  } catch {
    return null
  }
}

// =============================================================================
// Cisco ISE — connection test.
//
// Verifies a Connection's endpoint + credential with the same cheap probe the
// health check uses: GET /ers/config/endpointgroup?size=1 — a 200 confirms ERS
// is enabled on the node AND the ERS-Admin/ERS-Operator credential is accepted;
// a 401/403 proves ERS is reachable but flags the credential; a timeout usually
// means ERS itself is not enabled (the port is closed until an admin turns it
// on). See lib/iseApi.ts for the ERS API references.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) {
    return { ok: false, message: 'No endpoint is configured for this connection. Set the ISE PAN/admin node hostname (and ERS port, default 9060).' }
  }
  if (!hasUsableCredential(ctx.credential)) {
    return {
      ok: false,
      message:
        'No usable ISE ERS credential — attach an ISE administrator username + password (ERS-Admin or ERS-Operator group) to this connection.',
    }
  }

  const settings = readIseSettings(ctx.settings)
  const url = `${base}/ers/config/endpointgroup?size=1`
  const started = Date.now()
  try {
    const res = await iseRequest(url, { headers: buildAuthHeader(ctx.credential!), verifyTls: settings.verifyTls, timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached ISE but authentication failed (HTTP ${res.status}). Check the credential and that it belongs to the ERS-Admin or ERS-Operator group.`,
        details: [`Endpoint: ${base}`],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `ISE returned HTTP ${res.status}: ${ersErrorMessage(res)}`, details: [`Endpoint: ${base}`], latencyMs }
    }
    if (!res.ok) {
      return { ok: false, message: `ISE rejected the request (HTTP ${res.status}): ${ersErrorMessage(res)}`, details: [`Endpoint: ${base}`], latencyMs }
    }
    return { ok: true, message: `Connected to Cisco ISE ERS (HTTP ${res.status}).`, details: [`Endpoint: ${base}`, 'Auth: HTTP Basic (ERS)'], latencyMs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) {
      return {
        ok: false,
        message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${url}. ERS is closed until enabled on this node (Administration > System > Settings > API Settings).`,
        latencyMs,
      }
    }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port (ERS defaults to 9060).`, latencyMs }
    if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) {
      return {
        ok: false,
        message: `TLS/certificate error reaching ${base}: ${msg}. Turn off "Verify TLS certificate" in settings if ISE is using its default self-signed certificate.`,
        latencyMs,
      }
    }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
