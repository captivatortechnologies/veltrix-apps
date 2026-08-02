import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { loadPriorEntries } from './deploy'
import { extractSpecs, toRuleUpdateBody } from './_shared'

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Detect drift between the last-deployed firewall-rule configuration
 * (`ctx.deployedConfig`) and live pfSense state. Because rules are tracked
 * by canvas-item id (see deploy.ts's module doc), drift first re-derives the
 * itemId->pfsenseId map from the last successful deployment's rollbackData —
 * a rule this app never successfully deployed cannot be drift-checked.
 * A missing rule or a match-field change is CRITICAL; a behavior-only change
 * (log/statetype/descr) is a WARNING. Read-only.
 */
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

  const specs = extractSpecs(items).filter((s) => s.itemId && s.type)
  if (specs.length === 0) return { hasDrift: false, diffs }

  const prior = await loadPriorEntries(ctx.platform, ctx.deployedConfig)
  const priorByItemId = new Map(prior.map((p) => [p.itemId, p]))

  let live
  try {
    live = await client.listFirewallRules()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const liveById = new Map(live.filter((r) => r.id !== undefined).map((r) => [String(r.id), r]))

  for (const spec of specs) {
    const label = spec.descr || `rule (${spec.itemId})`
    const tracked = priorByItemId.get(spec.itemId)
    if (!tracked) {
      diffs.push({ field: label, expected: 'tracked', actual: 'never deployed', severity: 'warning' })
      continue
    }

    const found = liveById.get(String(tracked.id))
    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    const expected = toRuleUpdateBody(spec)
    if (found.type !== expected.type) diffs.push({ field: `${label}.type`, expected: expected.type, actual: found.type, severity: 'critical' })
    if (!sameList(Array.isArray(found.interface) ? found.interface : [], expected.interface)) {
      diffs.push({
        field: `${label}.interface`,
        expected: expected.interface.join(', '),
        actual: (found.interface ?? []).join(', '),
        severity: 'critical',
      })
    }
    if ((found.protocol ?? null) !== expected.protocol) {
      diffs.push({ field: `${label}.protocol`, expected: expected.protocol ?? '(any)', actual: found.protocol ?? '(any)', severity: 'critical' })
    }
    if (found.source !== expected.source) diffs.push({ field: `${label}.source`, expected: expected.source, actual: found.source, severity: 'critical' })
    if (found.destination !== expected.destination) {
      diffs.push({ field: `${label}.destination`, expected: expected.destination, actual: found.destination, severity: 'critical' })
    }
    if (Boolean(found.disabled) !== Boolean(expected.disabled)) {
      diffs.push({ field: `${label}.disabled`, expected: String(expected.disabled), actual: String(Boolean(found.disabled)), severity: 'warning' })
    }
    if (Boolean(found.log) !== Boolean(expected.log)) {
      diffs.push({ field: `${label}.log`, expected: String(expected.log), actual: String(Boolean(found.log)), severity: 'warning' })
    }
    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
