import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildPPClient,
  classifyNetworkError,
  ppErrorMessage,
  readPPSettings,
  resolvePPAuth,
  MISSING_CREDENTIAL_MESSAGE,
  MISSING_ORG_MESSAGE,
} from '../lib/proofpoint'

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
// Proofpoint Essentials — connection test.
//
// Verifies a Connection with a single authenticated GET /orgs/{org} against the
// Essentials Interface API. It proves the stack host is reachable, the admin
// credentials (X-User / X-Password) are valid, and the admin can see the
// organization named in the "Organization (primary domain)" setting. Runs
// in-process with the decrypted credential.
// =============================================================================

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const { auth } = resolvePPAuth(ctx.credential)
  if (!auth) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const { orgDomain } = readPPSettings(ctx.settings)
  if (!orgDomain) return { ok: false, message: MISSING_ORG_MESSAGE }

  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  const built = buildPPClient(host, ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }

  const { client, baseUrl } = built
  const details = [`Stack: ${baseUrl}`, `Organization: ${client.orgDomain}`, `Auth: admin ${auth.user} (X-User / X-Password)`]
  const started = Date.now()

  try {
    const res = await client.request('GET', client.orgPath)
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Proofpoint Essentials rejected the admin credentials (HTTP ${res.status}). Check the admin email/password and that the account is an Org/Channel Admin (not read-only).`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Organization "${client.orgDomain}" was not found (404). Check the "Organization (primary domain)" setting and that this admin can manage it.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Proofpoint Essentials — organization "${client.orgDomain}".`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Proofpoint Essentials API returned HTTP ${res.status}: ${ppErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyNetworkError(err, baseUrl), details, latencyMs: Date.now() - started }
  }
}
