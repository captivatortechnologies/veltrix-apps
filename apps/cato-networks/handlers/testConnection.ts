import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildCatoClient, graphqlErrorMessage } from '../lib/cato'

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
// Cato Networks - connection test.
//
// Verifies a Connection by running a minimal, universally-available read
// (`accountSnapshot(accountID) { id }`) against the CMA GraphQL API with the
// configured `x-api-key` + `x-account-id`. A successful response proves the
// API key is valid AND scoped to the declared account id together - it does
// not require any specific policy/object permission, only the API key's own
// validity.
// =============================================================================

const ACCOUNT_SNAPSHOT_QUERY = `query TestConnection($accountId: ID!) {
  accountSnapshot(accountID: $accountId) {
    id
    timestamp
  }
}`

function classifyNetworkError(err: unknown, apiUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Cato at ${apiUrl}.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${apiUrl}.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${apiUrl}.`
  return `Could not reach Cato (${apiUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const hostname = ctx.endpoint || ctx.component?.hostname || ''
  const built = buildCatoClient(hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, accountId } = built

  const started = Date.now()
  try {
    const res = await client.graphql<{ accountSnapshot?: { id?: string | null } }>(ACCOUNT_SNAPSHOT_QUERY, { accountId })
    const latencyMs = Date.now() - started

    if (res.transportError) {
      return { ok: false, message: classifyNetworkError(new Error(res.transportError), 'api.catonetworks.com'), latencyMs }
    }
    if (res.errors) {
      return {
        ok: false,
        message: `Cato rejected the request: ${graphqlErrorMessage(res.errors)}`,
        details: [`Account: ${accountId}`],
        latencyMs,
      }
    }
    if (!res.data?.accountSnapshot?.id) {
      return {
        ok: false,
        message: `Cato accepted the API key but returned no account snapshot for account ${accountId}. Check the Account ID.`,
        details: [`Account: ${accountId}`],
        latencyMs,
      }
    }
    return {
      ok: true,
      message: `Connected to Cato account ${accountId}.`,
      details: [`Account: ${accountId}`, 'Auth: x-api-key'],
      latencyMs,
    }
  } catch (error) {
    return { ok: false, message: classifyNetworkError(error, 'api.catonetworks.com'), latencyMs: Date.now() - started }
  }
}
