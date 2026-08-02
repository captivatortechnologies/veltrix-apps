import type { TestConnectionContext, TestConnectionResult } from '@veltrixsecops/app-sdk'
import { darktraceAuthFrom, darktraceFetch, buildQuery, requestUri } from '../lib/darktraceApi'

const TIMEOUT_MS = 10_000

/** Normalize a raw endpoint/host into an https base URL with no trailing slash. */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

// =============================================================================
// Darktrace — connection test.
//
// Verifies a Connection's endpoint + DSA token pair by calling the Darktrace REST
// API (GET /intelfeed?sources=true — lightweight, returns only the watched-list
// source labels, HTTPS, self-signed tolerated). A 2xx confirms the endpoint
// resolves AND the DSA signature validates; a 401/403 proves reachability but flags
// the token pair. Verify /intelfeed against a live Darktrace.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }

  const auth = darktraceAuthFrom(ctx.credential)
  if (!auth) {
    return {
      ok: false,
      message: 'Darktrace authenticates with a DSA token pair — set the public token as the username and the private token as the secret on this connection.',
    }
  }

  const uri = requestUri('/intelfeed', buildQuery({ sources: true }))
  const started = Date.now()
  try {
    const res = await darktraceFetch(base, uri, auth, { timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached Darktrace but authentication failed (HTTP ${res.status}). Check the public + private token pair.`,
        details: [`Endpoint: ${base}`, 'Auth: DSA token pair'],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Darktrace returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to Darktrace (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, 'Auth: DSA token pair'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that Darktrace is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
