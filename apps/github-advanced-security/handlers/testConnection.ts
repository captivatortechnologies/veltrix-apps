import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildGithubClient } from '../lib/githubApi'

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

// =============================================================================
// GitHub Advanced Security — connection test.
//
// Verifies a Connection's token by calling the GitHub REST API (GET /user). A 200
// confirms the endpoint resolves AND the token authenticates; a 401/403 proves
// reachability but flags the token. Base URL is https://api.github.com, or a GHES
// base derived from the endpoint / api_base_url setting.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }

  const rawHost = (ctx.endpoint || ctx.component?.hostname || '').trim()
  const built = buildGithubClient(rawHost, ctx.credential, ctx.settings ?? {})
  if ('error' in built) {
    return { ok: false, message: 'GitHub authenticates with a token — attach one to this connection.' }
  }
  const { client, baseUrl } = built

  const started = Date.now()
  try {
    const res = await client.getAuthenticatedUser()
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached GitHub but authentication failed (HTTP ${res.status}). Check the token and its scopes.`,
        details: [`Endpoint: ${baseUrl}`, 'Auth: token (Bearer)'],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `GitHub returned HTTP ${res.status}.`, details: [`Endpoint: ${baseUrl}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to GitHub (HTTP ${res.status}).`,
      details: [`Endpoint: ${baseUrl}`, 'Auth: token (Bearer)'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out connecting to ${baseUrl}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${baseUrl}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${baseUrl}.`, latencyMs }
    return { ok: false, message: `Could not reach ${baseUrl}: ${msg}`, latencyMs }
  }
}
