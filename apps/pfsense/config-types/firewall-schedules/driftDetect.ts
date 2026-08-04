import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { extractSpecs, scheduleKey, toScheduleBody } from './_shared'

function sameList(a: number[] | undefined, b: number[]): boolean {
  const arr = a ?? []
  return arr.length === b.length && arr.every((v, i) => Number(v) === b[i])
}

/** Detect drift between the last-deployed schedule configuration and live pfSense state, matched by name. Read-only. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const auth = await client.authenticate()
  if (auth.error) return { hasDrift: false, diffs }

  const specs = extractSpecs(items).filter((s) => s.name && s.hour)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await client.listFirewallSchedules()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const byName = new Map(live.filter((s) => s.name).map((s) => [scheduleKey(s.name), s]))

  for (const spec of specs) {
    const found = byName.get(scheduleKey(spec.name))
    const label = spec.name

    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    const expected = toScheduleBody(spec).timerange[0]
    const actual = Array.isArray(found.timerange) ? found.timerange[0] : undefined

    if (!actual) {
      diffs.push({ field: `${label}.timerange`, expected: 'present', actual: 'absent', severity: 'critical' })
    } else {
      if (expected.hour !== actual.hour) diffs.push({ field: `${label}.hour`, expected: expected.hour, actual: actual.hour, severity: 'critical' })
      if (!sameList(actual.position ?? undefined, expected.position ?? [])) {
        diffs.push({ field: `${label}.position`, expected: (expected.position ?? []).join(', ') || '(none)', actual: (actual.position ?? []).join(', ') || '(none)', severity: 'critical' })
      }
      if (!sameList(actual.month, expected.month ?? [])) {
        diffs.push({ field: `${label}.month`, expected: (expected.month ?? []).join(', ') || '(none)', actual: (actual.month ?? []).join(', ') || '(none)', severity: 'critical' })
      }
      if (!sameList(actual.day, expected.day ?? [])) {
        diffs.push({ field: `${label}.day`, expected: (expected.day ?? []).join(', ') || '(none)', actual: (actual.day ?? []).join(', ') || '(none)', severity: 'critical' })
      }
    }

    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
