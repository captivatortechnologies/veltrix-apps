import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient, checkpointErrorMessage } from '../lib/checkpointApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever @veltrixsecops/app-sdk
// version the platform resolves at load time. Only long-standing types
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
// Check Point — connection test.
//
// Runs the exact session unit of work a read-only probe needs: login, a
// bounded show-hosts read (limit 1 — proves the session + database access
// without depending on any host actually existing), then logout. No publish
// or discard — nothing was changed.
// =============================================================================

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const built = buildCheckpointClient(ctx.component?.hostname ?? undefined, ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client, host } = built

  const details = [`Host: ${host}`, 'Auth: Management API session login']
  const started = Date.now()

  const login = await client.login()
  if (login.error) {
    return { ok: false, message: login.error, details, latencyMs: Date.now() - started }
  }

  const res = await client.call<{ objects?: unknown[] }>('show-hosts', { limit: 1, 'details-level': 'uid' })
  const latencyMs = Date.now() - started
  await client.logout()

  if (res.transportError) {
    return { ok: false, message: `Could not reach the Management API: ${res.transportError}`, details, latencyMs }
  }
  if (res.ok) {
    return { ok: true, message: `Connected to the Check Point Management API on ${host}.`, details, latencyMs }
  }
  return {
    ok: false,
    message: `Check Point rejected show-hosts: ${checkpointErrorMessage(res)}. Check the credential's ` +
      'permission profile and, if applicable, the configured Domain.',
    details,
    latencyMs,
  }
}
