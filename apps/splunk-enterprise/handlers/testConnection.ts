import type { TestConnectionContext, TestConnectionResult } from '@veltrixsecops/app-sdk'
import { buildAuthHeader } from '../lib/splunkApi'

// =============================================================================
// Splunk Enterprise — connection test.
//
// Verifies a Connection's endpoint + credential by hitting the Splunk management
// API's `/services/server/info` (the same reachability probe the health checks
// use). A 200 confirms the endpoint is reachable AND the credential authenticates.
// Runs in-process on the platform with the decrypted credential.
// =============================================================================

const TIMEOUT_MS = 10_000

/** Normalize a raw endpoint/host into an https base URL with no trailing slash. */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

function classifyNetworkError(err: unknown, base: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}. Check the host/port and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve the host in ${base}. Check the endpoint.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${base}. Check the port and that Splunk is listening.`
  if (/certificate|self.signed|CERT_|SSL|TLS/i.test(msg)) return `TLS error reaching ${base}: ${msg}`
  return `Could not reach ${base}: ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }

  const authType = ctx.credential.apiToken ? 'API token' : 'username & password'
  const headers = buildAuthHeader(ctx.credential)
  const url = `${base}/services/server/info?output_mode=json`
  const started = Date.now()

  try {
    const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const latencyMs = Date.now() - started

    if (res.status === 401) {
      return {
        ok: false,
        message: 'Authentication failed (401). Check the username/password or token.',
        details: [`Endpoint: ${base}`, `Auth: ${authType}`],
        latencyMs,
      }
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200)
      return {
        ok: false,
        message: `Splunk returned HTTP ${res.status}.`,
        details: [`Endpoint: ${base}`, ...(body ? [`Response: ${body}`] : [])],
        latencyMs,
      }
    }

    let version = ''
    try {
      const data = JSON.parse(await res.text())
      version = data?.entry?.[0]?.content?.version ?? ''
    } catch {
      /* body isn't required to succeed */
    }
    return {
      ok: true,
      message: version ? `Connected to Splunk ${version}.` : 'Connected to the Splunk management API.',
      details: [`Endpoint: ${base}`, `Auth: ${authType}`, ...(version ? [`Version: ${version}`] : [])],
      latencyMs,
    }
  } catch (err) {
    return {
      ok: false,
      message: classifyNetworkError(err, base),
      details: [`Endpoint: ${base}`, `Auth: ${authType}`],
      latencyMs: Date.now() - started,
    }
  }
}
