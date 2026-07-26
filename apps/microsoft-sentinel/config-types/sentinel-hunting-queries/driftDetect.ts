import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { listSavedSearches, type LiveSavedSearch } from './healthCheck'
import { extractSavedSearchSpecs } from './validate'

/**
 * Detect drift between the deployed hunting queries and the live workspace. A
 * declared saved search that no longer exists is critical drift; a field that
 * differs (category, display name, query, function alias/parameters) is warning
 * drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractSavedSearchSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own deploys authenticate as the app registration — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listSavedSearches(client)
    const byId = new Map<string, LiveSavedSearch>()
    for (const s of live) if (s.name) byId.set(s.name.toLowerCase(), s)

    for (const spec of specs) {
      const before = diffs.length
      const resourceId = client.workspaceChildPath(`/savedSearches/${spec.savedSearchId}`)
      const liveSearch = byId.get(spec.savedSearchId.toLowerCase())
      if (!liveSearch) {
        diffs.push({ field: `hunting_query:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
        continue
      }
      const props = liveSearch.properties ?? {}
      const comparisons: Array<{ label: string; want: string; have: string }> = [
        { label: 'category', want: spec.category, have: props.category ?? '' },
        { label: 'displayName', want: spec.name, have: props.displayName ?? '' },
        { label: 'query', want: spec.query, have: props.query ?? '' },
        { label: 'functionAlias', want: spec.functionAlias, have: props.functionAlias ?? '' },
        { label: 'functionParameters', want: spec.functionParameters, have: props.functionParameters ?? '' },
      ]
      for (const { label, want, have } of comparisons) {
        if (want !== have) {
          diffs.push({ field: `${spec.name}.${label}`, expected: want, actual: have, severity: 'warning' })
        }
      }
      // Attribute every diff this saved search produced to the last human change.
      await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
