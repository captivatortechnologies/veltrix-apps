import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractArielLookupSpecs, type LookupEntry } from './validate'
import { listLookups } from './deploy'

type Diffs = DriftResult['diffs']

function sortedPairs(entries: LookupEntry[]): string {
  return JSON.stringify([...entries].map((e) => `${e.key}=${e.value}`).sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildQRadarClient(cred, settings)

  const specs = extractArielLookupSpecs(ctx.deployedConfig).filter((s) => s.name)
  const live = await listLookups(client)
  // An unreadable console is not an empty one. Reporting every declared
  // object as critically absent because one read failed pages somebody for
  // deletions that never happened.
  if (live === null) return { hasDrift: false, diffs: [], checked: false }
  const byName = new Map(live.filter((l) => l.name).map((l) => [String(l.name).toLowerCase(), l]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const lookup = byName.get(spec.name.toLowerCase())
    if (!lookup) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const liveType = lookup.type ?? ''
    if (liveType && liveType !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: liveType, severity: 'critical' })
    }
    if ((lookup.default_value ?? '') !== spec.defaultValue) {
      diffs.push({ field: `${spec.name}.defaultValue`, expected: spec.defaultValue, actual: lookup.default_value ?? '', severity: 'warning' })
    }
    const liveEntries = Object.keys(lookup.map ?? {}).map((key) => ({ key, value: lookup.map?.[key] ?? '' }))
    if (sortedPairs(liveEntries) !== sortedPairs(spec.entries)) {
      diffs.push({ field: `${spec.name}.entries`, expected: spec.entries.map((e) => `${e.key}=${e.value}`).sort(), actual: liveEntries.map((e) => `${e.key}=${e.value}`).sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
