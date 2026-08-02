import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, getFirmwareStatus, opnsenseErrorMessage } from '../lib/opnsenseApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever @veltrixsecops/app-sdk
// version the platform resolves at load time. Only long-standing types
// (CredentialRef) are imported.
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

// =============================================================================
// OPNsense — connection test.
//
// GET /api/core/firmware/status — a read-only probe that answers to both GET
// and POST (FirmwareController::statusAction only runs its synchronous
// "firmware probe" backend check on a POST — see lib/opnsenseApi.ts), so a
// bare GET proves the host, TLS trust setting and API key/secret pair all
// work without staging or applying any firewall change.
// =============================================================================

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const built = buildOpnsenseClient(
    ctx.component?.hostname ?? undefined,
    ctx.component?.port ?? undefined,
    ctx.credential,
    ctx.settings,
  )
  if ('error' in built) return { ok: false, message: built.error }
  const { client, host } = built

  const details = [`Host: ${host}`, 'Auth: HTTP Basic (API key + secret)']
  const started = Date.now()
  const res = await getFirmwareStatus(client)
  const latencyMs = Date.now() - started

  if (res.transportError) {
    return { ok: false, message: `Could not reach the OPNsense API: ${res.transportError}`, details, latencyMs }
  }
  if (res.ok) {
    const version = res.data?.product?.product_version
    return {
      ok: true,
      message: `Connected to the OPNsense API on ${host}${version ? ` (${version})` : ''}.`,
      details,
      latencyMs,
    }
  }
  return {
    ok: false,
    message: `OPNsense rejected the request: ${opnsenseErrorMessage(res)}. Check the API key/secret pair and ` +
      "the key owner's Effective Privileges.",
    details,
    latencyMs,
  }
}
