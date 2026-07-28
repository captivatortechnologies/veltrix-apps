import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { listAnomalySettings } from './healthCheck'
import { extractAnomalySpecs, thresholdObservationsOf, type AnomalySettingSpec } from './validate'

type SettingField = { label: string; specKey: keyof AnomalySettingSpec; liveKey: string }

/** Scalar properties compared for every anomaly setting. */
const COMPARED: SettingField[] = [
  { label: 'enabled', specKey: 'enabled', liveKey: 'enabled' },
  { label: 'settingsStatus', specKey: 'settingsStatus', liveKey: 'settingsStatus' },
  { label: 'frequency', specKey: 'frequency', liveKey: 'frequency' },
  { label: 'settingsDefinitionId', specKey: 'settingsDefinitionId', liveKey: 'settingsDefinitionId' },
]

/** name -> value map of a customizableObservations object's threshold observations. */
function thresholdMap(observations: unknown): Map<string, string> {
  const obs = observations && typeof observations === 'object' && !Array.isArray(observations)
    ? (observations as Record<string, unknown>)
    : null
  const map = new Map<string, string>()
  for (const t of thresholdObservationsOf(obs)) {
    if (t.name) map.set(t.name, t.value)
  }
  return map
}

/**
 * Detect drift between the deployed anomaly settings and the live workspace. A
 * declared setting that no longer exists is critical drift; a key field that
 * differs from the declared configuration — including a tuned threshold value —
 * is warning drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractAnomalySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own deploys authenticate as the app registration — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listAnomalySettings(client)
    const byName = new Map(live.filter((r) => r.name).map((r) => [(r.name as string).toLowerCase(), r]))

    for (const spec of specs) {
      const before = diffs.length
      const resourceId = client.sentinelPath(`/securityMLAnalyticsSettings/${spec.settingsResourceName}`)
      const liveSetting = byName.get(spec.settingsResourceName.toLowerCase())
      if (!liveSetting) {
        diffs.push({ field: `anomaly:${spec.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
        continue
      }

      const props = liveSetting.properties ?? {}
      for (const { label, specKey, liveKey } of COMPARED) {
        const want = spec[specKey]
        const have = props[liveKey]
        if (String(want ?? '') !== String(have ?? '')) {
          diffs.push({ field: `${spec.name}.${label}`, expected: String(want ?? ''), actual: String(have ?? ''), severity: 'warning' })
        }
      }

      // Declared thresholds: any tuned threshold whose live value differs is drift.
      const liveThresholds = thresholdMap(props.customizableObservations)
      for (const t of thresholdObservationsOf(spec.customizableObservations)) {
        if (!t.name) continue
        const have = liveThresholds.get(t.name)
        if (String(t.value ?? '') !== String(have ?? '')) {
          diffs.push({
            field: `${spec.name}.threshold:${t.name}`,
            expected: String(t.value ?? ''),
            actual: String(have ?? ''),
            severity: 'warning',
          })
        }
      }

      // Attribute every diff this setting produced to the last human change (once);
      // a no-op (no query) when the setting did not drift.
      await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
