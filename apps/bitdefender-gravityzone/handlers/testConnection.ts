import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient, resolveGravityZoneApiKey, MISSING_CREDENTIAL_MESSAGE } from '../lib/gravityZone'
import { getApiKeyDetails } from '../lib/gravityZoneApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves when it loads the
// handler - older SDKs predate these type exports. Only long-standing types
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
// Bitdefender GravityZone — connection test.
//
// Calls general.getApiKeyDetails — the lightest documented JSON-RPC method
// (takes no parameters) — which both confirms the API key is valid/enabled
// and identifies the account it belongs to.
// https://www.bitdefender.com/business/support/en/77209-140282-getapikeydetails.html
// =============================================================================

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveGravityZoneApiKey(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const hostname = ctx.endpoint || ctx.component?.hostname || ''
  const built = buildGravityZoneClient(hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client, baseUrl } = built

  const started = Date.now()
  try {
    const details = await getApiKeyDetails(client)
    const latencyMs = Date.now() - started
    return {
      ok: true,
      message: `Connected to GravityZone${details.email ? ` (API key owned by ${details.email})` : ''}.`,
      details: [`Target: ${baseUrl}`, 'Auth: API key (HTTP Basic, empty password)'],
      latencyMs,
    }
  } catch (error) {
    const latencyMs = Date.now() - started
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message, details: [`Target: ${baseUrl}`], latencyMs }
  }
}
