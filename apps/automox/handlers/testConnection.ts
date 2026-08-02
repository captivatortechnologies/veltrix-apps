import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildAutomoxClient,
  automoxErrorMessage,
  parseJson,
  resolveOrgId,
  AUTOMOX_API_BASE,
} from '../lib/automoxApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever @veltrixsecops/app-sdk
// version the platform resolves when it loads the handler.
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

interface AutomoxOrgSummary {
  id?: number
  name?: string
}

// =============================================================================
// Automox — connection test.
//
// Verifies a Connection with `GET /orgs` — the one Automox endpoint this app
// uses that does NOT require (or accept) an Organization ID, so it validates
// the Bearer API key on its own. A 2xx confirms the key authenticates;
// 401/403 = bad/disabled key. When the key is valid, the returned org list is
// also used to cross-check the configured Organization ID (credential
// username) so a typo surfaces here rather than as an opaque 400/404 on the
// first deploy.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }

  const built = buildAutomoxClient(ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client } = built

  const orgId = resolveOrgId(ctx.credential)
  const details = [`Endpoint: ${AUTOMOX_API_BASE}`, 'Auth: Bearer API key', `Organization ID: ${orgId}`]
  const started = Date.now()

  try {
    const res = await client.request('GET', '/orgs', { orgScoped: false })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Automox rejected the API key (HTTP ${res.status}). Check the key and that it is enabled.`,
        details,
        latencyMs,
      }
    }
    if (!res.ok) {
      return {
        ok: false,
        message: `Automox returned HTTP ${res.status}: ${automoxErrorMessage(res)}`,
        details,
        latencyMs,
      }
    }

    const orgs = parseJson<AutomoxOrgSummary[]>(res.body) ?? []
    if (orgId && orgs.length > 0 && !orgs.some((org) => org.id === orgId)) {
      return {
        ok: false,
        message:
          `The API key is valid but Organization ID ${orgId} was not found among the ${orgs.length} ` +
          'organization(s) this key can access. Check the Organization ID (credential username).',
        details: [...details, `Accessible org ids: ${orgs.map((o) => o.id).join(', ')}`],
        latencyMs,
      }
    }

    return {
      ok: true,
      message: `Connected to Automox (org ${orgId}).`,
      details,
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) {
      return { ok: false, message: `Timed out reaching Automox (${AUTOMOX_API_BASE}).`, details, latencyMs }
    }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
      return { ok: false, message: 'Could not resolve console.automox.com. Check network reachability.', details, latencyMs }
    }
    return { ok: false, message: `Could not reach Automox: ${msg}`, details, latencyMs }
  }
}
