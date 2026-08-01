import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildServiceNowClient,
  resolveServiceNowCredentials,
  serviceNowErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/servicenowApi'

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
// ServiceNow — connection test.
//
// Verifies a Connection with a single authenticated Table API read:
//   GET /api/now/table/sys_user?sysparm_limit=1
// It proves the instance URL resolves AND the Basic-auth username/password are
// valid. Runs in-process with the decrypted credential.
// =============================================================================

function classifyProbeError(err: unknown, instanceUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching ServiceNow at ${instanceUrl}. Check the instance URL and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${instanceUrl}. Check the instance address (e.g. dev12345.service-now.com).`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${instanceUrl}. Check the instance URL.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) {
    return `TLS/certificate error reaching ${instanceUrl}: ${msg}.`
  }
  return `Could not reach ServiceNow (${instanceUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message:
        'No endpoint is configured for this connection. Set the ServiceNow instance address ' +
        '(e.g. dev12345.service-now.com) on the connection.',
    }
  }
  if (!resolveServiceNowCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildServiceNowClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, instanceUrl } = built
  const details = [`Instance: ${instanceUrl}`, 'Auth: HTTP Basic']
  const started = Date.now()

  try {
    const res = await client.list('sys_user', { limit: 1, fields: ['sys_id'] })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `ServiceNow rejected the credential (HTTP ${res.status}). Check the integration user name/password and that the account has API/table access.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to ServiceNow (${instanceUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `ServiceNow API returned HTTP ${res.status}: ${serviceNowErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, instanceUrl), details, latencyMs: Date.now() - started }
  }
}
