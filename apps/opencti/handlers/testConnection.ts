import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { openctiRequest, buildAuthHeader } from '../lib/openctiApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever SDK the platform resolves.
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

const TIMEOUT_MS = 10_000

// The connectivity probe: read the OpenCTI version. Verify against a live OpenCTI instance.
const PROBE_QUERY = 'query { about { version } }'

/** Normalize a raw endpoint/host into an https base URL with no trailing slash. */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

// =============================================================================
// OpenCTI — connection test.
//
// Verifies a Connection's endpoint + API token by POSTing a GraphQL query to the
// OpenCTI API (POST /graphql, HTTPS, self-signed tolerated). A 200 carrying
// `data.about.version` confirms the endpoint resolves AND the token authenticates;
// a 401/403 proves reachability but flags the token. Verify /graphql +
// `about { version }` against a live OpenCTI instance.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }
  if (!ctx.credential.apiToken) {
    return { ok: false, message: 'OpenCTI authenticates with an API token — attach one to this connection.' }
  }

  const started = Date.now()
  try {
    const res = await openctiRequest(`${base}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeader(ctx.credential) },
      body: JSON.stringify({ query: PROBE_QUERY, variables: {} }),
      timeoutMs: TIMEOUT_MS,
    })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached OpenCTI but authentication failed (HTTP ${res.status}). Check the API token.`,
        details: [`Endpoint: ${base}`, 'Auth: API token (Bearer)'],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `OpenCTI returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }

    // 2xx — inspect the GraphQL body: data proves the token works, an errors
    // payload (e.g. a rejected token) surfaces as an auth failure.
    let version: string | undefined
    let graphqlError: string | undefined
    try {
      const parsed = JSON.parse(res.body || '{}') as {
        data?: { about?: { version?: string } }
        errors?: Array<{ message?: string }>
      }
      version = parsed.data?.about?.version
      if (parsed.errors && parsed.errors.length > 0) graphqlError = parsed.errors[0]?.message
    } catch {
      // non-JSON body — fall through to the generic reachable result below
    }

    if (graphqlError && version === undefined) {
      return {
        ok: false,
        message: `Reached OpenCTI but the query was rejected: ${graphqlError}. Check the API token.`,
        details: [`Endpoint: ${base}`, 'Auth: API token (Bearer)'],
        latencyMs,
      }
    }

    return {
      ok: true,
      message: version ? `Connected to OpenCTI ${version}.` : `Connected to OpenCTI (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, 'Auth: API token (Bearer)'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that OpenCTI is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}
