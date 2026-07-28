import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, SENTINEL_API_VERSION, type SentinelClient } from '../../lib/sentinel'
import { extractSourceControlSpecs, sourceControlKey } from './validate'

/**
 * A live SourceControl as returned by ARM. `name` is the server-assigned GUID;
 * repositoryAccess is NEVER present (it is write-only and never returned on GET),
 * so this shape deliberately omits it.
 */
export interface LiveSourceControl {
  /** The server GUID (also the ARM resource name). */
  name?: string
  properties?: {
    displayName?: string
    description?: string
    repoType?: string
    contentTypes?: string[]
    repository?: { url?: string; branch?: string; displayUrl?: string }
    version?: string
  }
}

/** List the workspace's source controls; throws on a non-OK response. */
export async function listSourceControls(client: SentinelClient): Promise<LiveSourceControl[]> {
  const res = await client.getAll<LiveSourceControl>(client.sentinelPath('/sourcecontrols'), SENTINEL_API_VERSION)
  if (!res.ok) {
    throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
  }
  return res.items
}

/** Index the live source controls by their display-name reconciliation key. */
export function indexByDisplayName(live: LiveSourceControl[]): Map<string, LiveSourceControl> {
  const byName = new Map<string, LiveSourceControl>()
  for (const sc of live) {
    const name = sc.properties?.displayName
    if (name) byName.set(sourceControlKey(name), sc)
  }
  return byName
}

/**
 * Health check for source controls:
 *   1. ARM reachability + token/permission validity (a sourcecontrols list)
 *   2. Every declared repository connection still exists (matched by display name)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'sentinel_credential', passed: false, message: built.error }] }
  }
  const { client, armHost } = built

  const start = Date.now()
  let live: LiveSourceControl[] | null = null
  try {
    live = await listSourceControls(client)
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const byName = indexByDisplayName(live)
    for (const spec of extractSourceControlSpecs(ctx.canvas).filter((s) => s.displayName)) {
      const present = byName.has(sourceControlKey(spec.displayName))
      checks.push({
        name: `source_control:${spec.displayName}`,
        passed: present,
        message: present ? `Source control "${spec.displayName}" is present` : `Source control "${spec.displayName}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
