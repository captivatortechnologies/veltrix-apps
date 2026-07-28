import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { listSettings, type LiveProductSetting } from './healthCheck'
import { extractProductSettingSpecs, isToggleSetting, settingKey } from './validate'

/** Order-independent, canonical rendering of a list-valued setting for comparison. */
function normalizeList(values: string[] | undefined): string {
  return [...(values ?? [])].map((v) => String(v).trim()).sort().join(', ')
}

/**
 * Detect drift between the deployed product settings and the live workspace. A
 * declared setting that no longer exists is critical drift; a differing toggle
 * (Anomalies / EyesOn isEnabled) or list (EntityAnalytics entityProviders, Ueba
 * dataSources) is warning drift. Each drifted setting is attributed to the last
 * MANUAL change via the Azure Activity Log.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractProductSettingSpecs(ctx.deployedConfig).filter((s) => s.setting)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own deploys authenticate as the app registration — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listSettings(client)
    const byName = new Map<string, LiveProductSetting>()
    for (const s of live) if (s.name) byName.set(s.name.toLowerCase(), s)

    for (const spec of specs) {
      const before = diffs.length
      const resourceId = client.sentinelPath(`/settings/${spec.setting}`)
      const liveSetting = byName.get(settingKey(spec.setting))
      if (!liveSetting) {
        diffs.push({ field: `setting:${spec.setting}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
        continue
      }

      const props = liveSetting.properties ?? {}
      if (isToggleSetting(spec.setting)) {
        const haveEnabled = props.isEnabled === true
        if (spec.isEnabled !== haveEnabled) {
          diffs.push({ field: `${spec.setting}.isEnabled`, expected: String(spec.isEnabled), actual: String(haveEnabled), severity: 'warning' })
        }
      } else if (spec.setting === 'EntityAnalytics') {
        const want = normalizeList(spec.entityProviders)
        const have = normalizeList(props.entityProviders)
        if (want !== have) {
          diffs.push({ field: `${spec.setting}.entityProviders`, expected: want, actual: have, severity: 'warning' })
        }
      } else if (spec.setting === 'Ueba') {
        const want = normalizeList(spec.dataSources)
        const have = normalizeList(props.dataSources)
        if (want !== have) {
          diffs.push({ field: `${spec.setting}.dataSources`, expected: want, actual: have, severity: 'warning' })
        }
      }

      // Attribute every diff this setting produced to the last human change.
      await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
