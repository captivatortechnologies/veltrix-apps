import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildSemgrepClient,
  deploymentSlugs,
  readSemgrepSettings,
  resolveSemgrepToken,
  semgrepErrorMessage,
  SEMGREP_BASE_URL,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/semgrepApi'

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
// Semgrep — connection test.
//
// Verifies a Connection with a single authenticated request against the public
// API: GET /api/v1/deployments. This proves the fixed Semgrep base URL is
// reachable and the API token (Bearer) is valid. When a Deployment Slug app
// setting is set, it additionally checks the slug is among the deployments the
// token can access. Runs in-process with the decrypted token.
// =============================================================================

function classifyProbeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching the Semgrep API at ${SEMGREP_BASE_URL}. Check network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${SEMGREP_BASE_URL}. Check outbound network / DNS.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${SEMGREP_BASE_URL}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${SEMGREP_BASE_URL}: ${msg}`
  return `Could not reach the Semgrep API (${SEMGREP_BASE_URL}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveSemgrepToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildSemgrepClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client } = built
  const { deploymentSlug } = readSemgrepSettings(ctx.settings)
  const details = [`Base URL: ${SEMGREP_BASE_URL}`, 'Auth: Bearer token', deploymentSlug ? `Slug: ${deploymentSlug}` : 'Slug: (not set)']
  const started = Date.now()

  try {
    const res = await client.listDeployments()
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Semgrep rejected the API token (HTTP ${res.status}). Check the token value and that it belongs to a Team/Enterprise-tier deployment.`,
        details,
        latencyMs,
      }
    }
    if (!res.ok) {
      return { ok: false, message: `Semgrep API returned HTTP ${res.status}: ${semgrepErrorMessage(res)}`, details, latencyMs }
    }

    const slugs = deploymentSlugs(res)
    if (deploymentSlug && slugs.length > 0 && !slugs.includes(deploymentSlug)) {
      return {
        ok: false,
        message: `Connected to Semgrep, but the token cannot access deployment "${deploymentSlug}". Accessible: ${slugs.join(', ')}. Update the "Deployment Slug" app setting.`,
        details,
        latencyMs,
      }
    }

    const accessible = slugs.length > 0 ? ` (accessible: ${slugs.join(', ')})` : ''
    return { ok: true, message: `Connected to Semgrep${accessible}.`, details, latencyMs }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err), details, latencyMs: Date.now() - started }
  }
}
