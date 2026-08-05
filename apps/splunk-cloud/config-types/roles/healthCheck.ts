import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
  splunkRestRequest,
} from '../../lib/splunkRest'
import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { describeTarget, resolveTargets, withTarget } from '../../lib/acsIdentity'
import { getAcsRole, ACS_ROLES_COLLECTION_PATH } from './acsRoles'
import { extractRoleSpecs, type RoleSpec } from './validate'

type Check = HealthCheckResult['checks'][0]

/**
 * Health check for Splunk Cloud role configuration, per role's declared
 * transport (see validate.ts):
 *
 *   REST: (1) the stack's REST API on port 8089 is reachable and the token is
 *         accepted — this tells the user whether Support has opened 8089 and
 *         whether their IP is on the `search-api` allow list; (2) every
 *         REST-transport role exists on the stack.
 *   ACS:  (1) ACS is reachable at every distinct search-head target used by an
 *         ACS-transport role (usually just the default); (2) every
 *         ACS-transport role exists AT EACH of its declared targets — a role
 *         present on one search head and missing on another is a real,
 *         reportable health problem this modeling makes visible.
 *
 * Score is the percentage of passed checks (0–100) across both transports.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)
  const restSpecs = specs.filter((s) => s.transport === 'rest')
  const acsSpecs = specs.filter((s) => s.transport === 'acs')

  const checks: Check[] = []

  if (restSpecs.length > 0) {
    checks.push(...(await restHealthChecks(ctx, restSpecs)))
  }
  if (acsSpecs.length > 0) {
    checks.push(...(await acsHealthChecks(ctx, acsSpecs)))
  }

  if (checks.length === 0) {
    // No roles declared — nothing to verify (validate.ts already blocks an
    // empty canvas from being deployed in the first place).
    return { healthy: true, score: 100, checks: [] }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return {
    healthy: passedCount === checks.length,
    score: Math.round((passedCount / checks.length) * 100),
    checks,
  }
}

// --- REST transport -----------------------------------------------------------

async function restHealthChecks(ctx: HealthCheckContext, specs: RoleSpec[]): Promise<Check[]> {
  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return [{ name: 'splunk_rest_token', passed: false, message: REST_TOKEN_MISSING }]
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  const checks: Check[] = []
  const reachable = await timedCheck('splunk_rest_reachable', async () => {
    await splunkRestRequest(`${baseUrl}/services/authorization/roles?count=1&output_mode=json`, {
      method: 'GET',
      headers: auth,
      timeoutMs,
    })
    return `Splunk Cloud REST API reachable for stack "${stack}" on port 8089`
  })
  checks.push(reachable)

  if (reachable.passed) {
    for (const spec of specs) {
      checks.push(
        await timedCheck(`role:${spec.name} (REST)`, async () => {
          const content = await getEntityContent(
            baseUrl,
            auth,
            `/services/authorization/roles/${encodeURIComponent(spec.name)}`,
            timeoutMs,
          )
          if (!content) throw new Error(`Role "${spec.name}" does not exist on the stack`)
          return `Role "${spec.name}" is present`
        }),
      )
    }
  }

  return checks
}

// --- ACS transport --------------------------------------------------------------

async function acsHealthChecks(ctx: HealthCheckContext, specs: RoleSpec[]): Promise<Check[]> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return [
      {
        name: 'acs_identity_token',
        passed: false,
        message:
          'No ACS token available — store the Splunk Cloud JWT (sc_admin) in the credential "API token" field',
      },
    ]
  }

  const settings = readAcsSettings(ctx.settings)
  const baseStack = resolveStackName(ctx.component.hostname)
  const acsBase: AcsRequestOptions = { baseUrl: settings.baseUrl, stack: baseStack, token, timeoutMs: settings.timeoutMs }

  // One reachability probe per DISTINCT target actually used, not per role.
  const distinctTargets = new Map<string, string | undefined>()
  for (const spec of specs) {
    for (const target of resolveTargets(spec.searchHeadTargets)) {
      distinctTargets.set(target ?? '', target)
    }
  }

  const reachability = new Map<string, boolean>()
  const checks: Check[] = []
  for (const [key, target] of distinctTargets) {
    const acs = withTarget(acsBase, baseStack, target)
    const check = await timedCheck(`acs_reachable:${describeTarget(target)}`, async () => {
      const res = await acsRequest(acs, 'GET', `${ACS_ROLES_COLLECTION_PATH}?count=1`)
      if (res.status !== 200) throw new Error(acsErrorMessage(res))
      return `ACS reachable for stack "${baseStack}" on ${describeTarget(target)}`
    })
    checks.push(check)
    reachability.set(key, check.passed)
  }

  for (const spec of specs) {
    const targets = resolveTargets(spec.searchHeadTargets)
    const multiTarget = targets.length > 1 || spec.searchHeadTargets.length > 0
    for (const target of targets) {
      const key = target ?? ''
      if (!reachability.get(key)) continue // Already reported as an ACS-unreachable check above.
      const label = multiTarget ? `role:${spec.name}@${describeTarget(target)} (ACS)` : `role:${spec.name} (ACS)`
      checks.push(
        await timedCheck(label, async () => {
          const acs = withTarget(acsBase, baseStack, target)
          const live = await getAcsRole(acs, spec.name)
          if (!live) throw new Error(`Role "${spec.name}" does not exist on ${describeTarget(target)}`)
          return `Role "${spec.name}" is present on ${describeTarget(target)}`
        }),
      )
    }
  }

  return checks
}

async function timedCheck(name: string, fn: () => Promise<string>): Promise<Check> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}
