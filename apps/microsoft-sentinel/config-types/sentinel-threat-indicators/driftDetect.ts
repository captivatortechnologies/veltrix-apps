import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { queryManagedIndicators, type LiveIndicator } from './healthCheck'
import { extractIndicatorSpecs, indicatorKey, type IndicatorSpec } from './validate'

/** A trimmed scalar/array comparison value → a stable string for drift equality. */
function normalizeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).sort().join(',')
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/**
 * Compare a declared indicator against its live properties, pushing a warning diff
 * per field that differs. Valid-from / valid-until are only compared when the spec
 * supplies them (a blank field is user-delegated to ARM and never drift).
 */
function compareIndicator(spec: IndicatorSpec, props: Record<string, unknown>, diffs: DriftDiff[]): void {
  const comparisons: Array<{ label: string; want: unknown; have: unknown }> = [
    { label: 'pattern', want: spec.pattern, have: props.pattern },
    { label: 'patternType', want: spec.stixType, have: props.patternType },
    { label: 'confidence', want: spec.confidence, have: props.confidence },
    { label: 'threatTypes', want: spec.threatTypes, have: props.threatTypes },
    { label: 'tags', want: spec.tags, have: props.threatIntelligenceTags },
    { label: 'revoked', want: spec.revoked, have: props.revoked },
  ]
  if (spec.validFrom) comparisons.push({ label: 'validFrom', want: spec.validFrom, have: props.validFrom })
  if (spec.validUntil) comparisons.push({ label: 'validUntil', want: spec.validUntil, have: props.validUntil })

  for (const { label, want, have } of comparisons) {
    const wantStr = normalizeValue(want)
    const haveStr = normalizeValue(have)
    if (wantStr !== haveStr) {
      diffs.push({ field: `${spec.displayName}.${label}`, expected: wantStr, actual: haveStr, severity: 'warning' })
    }
  }
}

/**
 * Detect drift between the deployed indicators and the live managed source. A
 * declared indicator that no longer exists is critical drift; a field that differs
 * from the declared configuration is warning drift. Attribution ("who changed it")
 * is resolved from the Azure Activity Log via the live indicator's ARM resource id.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractIndicatorSpecs(ctx.deployedConfig).filter((s) => s.displayName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own deploys authenticate as the app registration — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await queryManagedIndicators(client)
    const byKey = new Map<string, LiveIndicator>()
    for (const ind of live) {
      const dn = typeof ind.properties?.displayName === 'string' ? ind.properties.displayName : ''
      if (dn) byKey.set(indicatorKey(dn), ind)
    }

    for (const spec of specs) {
      const before = diffs.length
      const liveIndicator = byKey.get(indicatorKey(spec.displayName))
      if (!liveIndicator) {
        diffs.push({ field: `indicator:${spec.displayName}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      compareIndicator(spec, liveIndicator.properties ?? {}, diffs)
      // Attribute every diff this indicator produced to the last human change
      // (once); a no-op (no query) when the indicator did not drift.
      if (liveIndicator.id) {
        await attachDriftActor(client, diffs.slice(before), { resourceId: liveIndicator.id, excludeActorLogins })
      }
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
