import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, readPfsenseSettings } from '../../lib/pfsenseApi'
import { extractSpecs, userKey } from './_shared'

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((v) => setA.has(v))
}

/**
 * Detect drift between the last-deployed user configuration and live
 * pfSense state, matched by username. `password` is NEVER compared (write-
 * only in spirit, see _shared.ts's module doc — a stored hash isn't
 * meaningfully diffable against a canvas plaintext value anyway). A missing
 * user is CRITICAL; disabled/descr/expires/priv changes are WARNINGs.
 * Read-only.
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

  const specs = extractSpecs(items).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await client.listUsers()
  } catch {
    return { hasDrift: false, diffs: [{ field: 'pfsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' }] }
  }
  const byName = new Map(live.filter((u) => u.name).map((u) => [userKey(u.name), u]))

  for (const spec of specs) {
    const found = byName.get(userKey(spec.name))
    const label = spec.name

    if (!found) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if (Boolean(found.disabled) !== spec.disabled) {
      diffs.push({ field: `${label}.disabled`, expected: String(spec.disabled), actual: String(Boolean(found.disabled)), severity: 'warning' })
    }
    const liveDescr = (found.descr ?? '').trim()
    if (liveDescr !== spec.descr) diffs.push({ field: `${label}.descr`, expected: spec.descr, actual: liveDescr, severity: 'warning' })
    const liveExpires = (found.expires ?? '').trim()
    if (liveExpires !== spec.expires) diffs.push({ field: `${label}.expires`, expected: spec.expires || '(none)', actual: liveExpires || '(none)', severity: 'warning' })
    const livePriv = Array.isArray(found.priv) ? found.priv : []
    if (!sameSet(livePriv, spec.priv)) {
      diffs.push({ field: `${label}.priv`, expected: spec.priv.join(', ') || '(none)', actual: livePriv.join(', ') || '(none)', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
