import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import { extractStorySettingsSpecs } from './_shared'
import { findStory } from './deploy'

/**
 * Health check for Story Settings configuration:
 *   1. Tines API reachability + auth (GET /api/v1/stories answers 2xx)
 *   2. every declared story still exists
 *   3. its enabled/disabled state matches what this config type declared
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/stories', { query: { per_page: 1 } })
    reachable = res.ok
    checks.push({
      name: 'tines_reachable',
      passed: res.ok,
      message: res.ok ? `Tines reachable (HTTP ${res.status}).` : `Tines returned HTTP ${res.status}: ${tinesErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'tines_reachable',
      passed: false,
      message: `Tines unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractStorySettingsSpecs(ctx.canvas).filter((s) => s.storyName)
    for (const spec of specs) {
      try {
        const story = await findStory(client, spec.storyName, spec.teamId || undefined)
        const present = Boolean(story)
        checks.push({
          name: `story:${spec.storyName}`,
          passed: present,
          message: present ? `Story "${spec.storyName}" is present.` : `Story "${spec.storyName}" is missing.`,
        })
        if (story) {
          const enabledMatches = Boolean(story.disabled) === spec.disabled
          checks.push({
            name: `story:${spec.storyName}:enabled_state`,
            passed: enabledMatches,
            message: enabledMatches
              ? `Story "${spec.storyName}" enabled state matches declared config.`
              : `Story "${spec.storyName}" disabled=${Boolean(story.disabled)} does not match declared disabled=${spec.disabled}.`,
          })
        }
      } catch (error) {
        checks.push({
          name: `story:${spec.storyName}`,
          passed: false,
          message: `Could not look up story: ${error instanceof Error ? error.message : 'error'}`,
        })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
