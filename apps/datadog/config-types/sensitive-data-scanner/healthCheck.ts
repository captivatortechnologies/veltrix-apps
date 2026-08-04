import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildDatadogClient } from '../../lib/datadogApi'
import { readScannerConfig } from './deploy'
import { extractGroupSpecs, findGroupByName, parseJsonArray, ruleKey } from './_shared'

/**
 * Health check for Sensitive Data Scanner configuration:
 *   1. Datadog reachability + credential validity — a config graph read
 *   2. Every declared group (by name) exists
 *   3. Every declared rule within an existing group (by name) exists
 * Score is the fraction of passed checks (0-1).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'datadog_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const started = Date.now()
  let snapshot: Awaited<ReturnType<typeof readScannerConfig>> | null = null
  try {
    snapshot = await readScannerConfig(client)
    checks.push({ name: 'datadog_reachable', passed: true, message: `Datadog reachable at ${baseUrl}`, latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({
      name: 'datadog_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Could not reach Datadog',
      latencyMs: Date.now() - started,
    })
  }

  if (snapshot) {
    const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      const label = spec.name
      const foundGroup = findGroupByName(snapshot.groups, spec.name)
      checks.push({
        name: `group:${label}`,
        passed: !!foundGroup,
        message: foundGroup ? `Group "${label}" is present` : `Group "${label}" is missing`,
      })
      if (!foundGroup) continue

      const declaredRuleNames = parseJsonArray(spec.rulesRaw)
      const liveRuleIds = foundGroup.relationships?.rules?.data?.map((r) => r.id).filter((id): id is string => !!id) ?? []
      const liveRuleKeys = new Set(
        liveRuleIds
          .map((id) => snapshot!.rulesById.get(id)?.attributes?.name)
          .filter((n): n is string => typeof n === 'string')
          .map(ruleKey),
      )
      if (declaredRuleNames.ok) {
        for (const raw of declaredRuleNames.value ?? []) {
          const name = typeof raw === 'object' && raw !== null && 'name' in raw ? String((raw as { name?: unknown }).name ?? '') : ''
          if (!name) continue
          const present = liveRuleKeys.has(ruleKey(name))
          checks.push({ name: `rule:${label}/${name}`, passed: present, message: present ? `Rule "${name}" is present` : `Rule "${name}" is missing` })
        }
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length ? passedCount / checks.length : 0, checks }
}
