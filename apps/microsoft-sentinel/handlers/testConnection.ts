import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  resolveSentinelCredentials,
  MISSING_CREDENTIAL_MESSAGE,
  WORKSPACE_API_VERSION,
} from '../lib/sentinel'

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
// Microsoft Sentinel — connection test.
//
// Runs the OAuth2 client-credentials handshake (inside SentinelClient.request)
// and one lightweight authenticated GET of the Log Analytics workspace resource.
// A failed token exchange surfaces as a synthetic status:0 response; 401/403
// means the service principal lacks the Microsoft Sentinel Contributor role;
// 404 means the workspace address (subscription/resource group/name) is wrong.
// =============================================================================

function classifyNetworkError(err: unknown, armHost: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching ${armHost}. Check the Azure cloud setting and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${armHost}. Check the Azure cloud setting.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${armHost}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${armHost}: ${msg}`
  return `Could not reach Azure Resource Manager (${armHost}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveSentinelCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildSentinelClient(ctx.endpoint || ctx.component?.hostname || undefined, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, armHost, cloud } = built
  const details = [`ARM host: ${armHost}`, `Cloud: ${cloud}`, 'Auth: OAuth2 app registration (ARM scope)']
  const started = Date.now()

  try {
    const res = await client.request('GET', client.workspacePath(), { apiVersion: WORKSPACE_API_VERSION })
    const latencyMs = Date.now() - started

    if (res.status === 0) {
      return {
        ok: false,
        message: `Authentication failed: ${armErrorMessage(res)}. Check the Tenant ID and the credential's Client ID/Secret.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `ARM rejected the token (HTTP ${res.status}). The service principal needs the "Microsoft Sentinel Contributor" role scoped to the workspace resource group.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: 'Workspace not found (HTTP 404). Check the Subscription ID, Resource Group and Workspace Name app settings.',
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to the Microsoft Sentinel workspace via Azure Resource Manager (${armHost}).`, details, latencyMs }
    }
    return { ok: false, message: `ARM returned HTTP ${res.status}: ${armErrorMessage(res)}`, details, latencyMs }
  } catch (err) {
    return { ok: false, message: classifyNetworkError(err, armHost), details, latencyMs: Date.now() - started }
  }
}
