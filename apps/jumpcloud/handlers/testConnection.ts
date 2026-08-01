import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, resolveOrgId } from '../lib/jumpcloudApi'

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

// =============================================================================
// JumpCloud — connection test.
//
// Verifies a Connection by calling the JumpCloud API with the API key:
// `GET /api/v2/usergroups?limit=1`. A 2xx confirms the key authenticates;
// 401/403 = bad/disabled key. The base URL is fixed (JumpCloud is a single
// global console); the optional org id (x-org-id) is carried on the credential
// username for multi-tenant admins.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client } = built

  const orgId = resolveOrgId(ctx.credential)
  const authDetail = orgId ? `Auth: x-api-key (org ${orgId})` : 'Auth: x-api-key'

  const started = Date.now()
  try {
    const res = await client.request('GET', '/usergroups', { query: { limit: 1 } })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `JumpCloud rejected the API key (HTTP ${res.status}). Check the key and, for multi-tenant admins, the org id.`,
        details: ['Endpoint: https://console.jumpcloud.com/api/v2', authDetail],
        latencyMs,
      }
    }
    if (res.ok) {
      return {
        ok: true,
        message: 'Connected to JumpCloud.',
        details: ['Endpoint: https://console.jumpcloud.com/api/v2', authDetail],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `JumpCloud returned HTTP ${res.status}: ${jumpCloudErrorMessage(res)}`,
      details: ['Endpoint: https://console.jumpcloud.com/api/v2'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) {
      return { ok: false, message: 'Timed out reaching JumpCloud (https://console.jumpcloud.com).', latencyMs }
    }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
      return { ok: false, message: 'Could not resolve console.jumpcloud.com. Check network reachability.', latencyMs }
    }
    return { ok: false, message: `Could not reach JumpCloud: ${msg}`, latencyMs }
  }
}
