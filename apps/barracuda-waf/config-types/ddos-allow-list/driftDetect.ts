import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { allowListKey, extractDdosAllowListSpecs, listAllowList, type LiveAllowListEntry } from './validate'

/**
 * Detect drift between the deployed DDoS allow list and the live Application:
 * a declared IP missing live is critical; a live IP not declared (this config
 * type owns the full list) is also drift; field-level differences are warned.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client, appName } = built

  const specs = extractDdosAllowListSpecs(ctx.deployedConfig).filter((s) => s.ip)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAllowList(client, appName)
    const byKey = new Map<string, LiveAllowListEntry>(live.filter((e) => e.ip).map((e) => [allowListKey(e.ip as string), e]))
    const declaredKeys = new Set(specs.map((s) => allowListKey(s.ip)))

    for (const spec of specs) {
      const found = byKey.get(allowListKey(spec.ip))
      if (!found) {
        diffs.push({ field: spec.ip, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.netmask ?? '255.255.255.255') !== spec.netmask) {
        diffs.push({ field: `${spec.ip}.netmask`, expected: spec.netmask, actual: found.netmask ?? '255.255.255.255', severity: 'warning' })
      }
      if ((found.allow_bypass ?? false) !== spec.allowBypass) {
        diffs.push({ field: `${spec.ip}.allow_bypass`, expected: spec.allowBypass, actual: found.allow_bypass ?? false, severity: 'warning' })
      }
    }

    for (const entry of live) {
      if (entry.ip && !declaredKeys.has(allowListKey(entry.ip))) {
        diffs.push({ field: entry.ip, expected: 'not present (undeclared)', actual: 'present', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'barracuda-waf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
