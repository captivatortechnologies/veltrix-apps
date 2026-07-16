import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage, resolveSnykToken, MISSING_CREDENTIAL_MESSAGE } from '../lib/snyk'

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
// Snyk — connection test.
//
// Verifies a Connection with a single authenticated REST GET. When an
// Organization ID is set it fetches that org (GET /rest/orgs/{org_id}), which
// proves the token, region host AND org are all valid; otherwise it lists the
// orgs the token can see (GET /rest/orgs) to prove the token + region host.
// Runs in-process with the decrypted token.
// =============================================================================

function classifyProbeError(err: unknown, host: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching the Snyk API at ${host}. Check the region host and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${host}. Check the region host (api.snyk.io, api.eu.snyk.io, api.au.snyk.io).`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${host}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${host}: ${msg}`
  return `Could not reach the Snyk API (${host}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set the Snyk region API host (e.g. api.snyk.io) on the connection.',
    }
  }
  if (!resolveSnykToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildSnykClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, host: apiHost } = built
  const path = client.hasOrg ? client.restOrgPath() : '/orgs'
  const details = [`Host: ${apiHost}`, 'Auth: token', client.hasOrg ? 'Scope: organization' : 'Scope: token']
  const started = Date.now()

  try {
    const res = await client.rest('GET', path)
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Snyk rejected the API token (HTTP ${res.status}). Check the token value, that it matches this region, and that it can access the organization.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404 && client.hasOrg) {
      return {
        ok: false,
        message: 'Snyk could not find that organization (404). Check the Organization ID app setting.',
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Snyk (${apiHost}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Snyk API returned HTTP ${res.status}: ${snykErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, apiHost), details, latencyMs: Date.now() - started }
  }
}
