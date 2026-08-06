import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import { getRole } from './deploy'
import { extractRoleSpecs } from './validate'

/**
 * Health check for role configuration:
 *   1. Akeyless reachability + credential validity (POST /list-roles)
 *   2. Every declared role still exists, matched by name
 *   3. Every declared rule and auth-method association is still present
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'akeyless_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('akeyless_reachable', async () => {
    const res = await client.request('/list-roles')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Akeyless rejected the credentials (invalid Access ID/Key, or missing role permissions)')
    }
    if (!res.ok) throw new Error(akeylessErrorMessage(res))
    return `Akeyless (${baseUrl}) reachable`
  })
  checks.push(reachable)

  if (reachable.passed) {
    for (const spec of specs) {
      checks.push(
        await timedCheck(`role:${spec.name}`, async () => {
          const live = await getRole(client, spec.name)
          if (!live) throw new Error(`Role "${spec.name}" does not exist in the account`)

          const liveRuleKeys = new Set((live.rules?.path_rules ?? []).map((r) => `${r.type}::${r.path}`))
          const missingRules = spec.rules.filter((r) => !liveRuleKeys.has(`${r.ruleType}::${r.path}`))
          if (missingRules.length > 0) {
            throw new Error(`Role "${spec.name}" is missing ${missingRules.length} declared rule(s): ${missingRules.map((r) => r.path).join(', ')}`)
          }

          const liveAssocNames = new Set((live.role_auth_methods_assoc ?? []).map((a) => a.auth_method_name))
          const missingAssocs = spec.authMethodAssociations.filter((a) => !liveAssocNames.has(a.authMethodName))
          if (missingAssocs.length > 0) {
            throw new Error(
              `Role "${spec.name}" is missing ${missingAssocs.length} declared auth-method association(s): ${missingAssocs
                .map((a) => a.authMethodName)
                .join(', ')}`,
            )
          }

          return `Role "${spec.name}" is present with ${spec.rules.length} rule(s) and ${spec.authMethodAssociations.length} association(s)`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(name: string, fn: () => Promise<string>): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
