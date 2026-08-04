import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { extractSpecs, groupKey } from './_shared'

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((v) => setA.has(v))
}

/** Detect drift between the last-deployed user-group configuration and live pfSense state, matched by name. Read-only. */
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

  const specs = extractSpecs(items).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await client.listUserGroups()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const byName = new Map(live.filter((g) => g.name).map((g) => [groupKey(g.name), g]))

  for (const spec of specs) {
    const found = byName.get(groupKey(spec.name))
    const label = spec.name

    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    const liveMembers = Array.isArray(found.member) ? found.member : []
    if (!sameSet(liveMembers, spec.member)) {
      diffs.push({ field: `${label}.member`, expected: spec.member.join(', ') || '(none)', actual: liveMembers.join(', ') || '(none)', severity: 'warning' })
    }
    const livePriv = Array.isArray(found.priv) ? found.priv : []
    if (!sameSet(livePriv, spec.priv)) {
      diffs.push({ field: `${label}.priv`, expected: spec.priv.join(', ') || '(none)', actual: livePriv.join(', ') || '(none)', severity: 'warning' })
    }
    const liveDescr = (found.description ?? '').trim()
    if (liveDescr !== spec.description) {
      diffs.push({ field: `${label}.description`, expected: spec.description, actual: liveDescr, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
