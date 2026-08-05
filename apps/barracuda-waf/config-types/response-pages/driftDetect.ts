import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractResponsePageSpecs, listResponsePages, responsePageKey, type LiveResponsePage } from './validate'

/**
 * Detect drift between the deployed Response Pages and the live Application:
 * a declared page missing live is critical; a live page not declared (this
 * config type owns the full list) is drift; field differences are warned.
 * The (potentially large) body is only compared for equality, not embedded
 * verbatim in the diff.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client, appName } = built

  const specs = extractResponsePageSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listResponsePages(client, appName)
    const byKey = new Map<string, LiveResponsePage>(live.filter((p) => p.name).map((p) => [responsePageKey(p.name as string), p]))
    const declaredKeys = new Set(specs.map((s) => responsePageKey(s.name)))

    for (const spec of specs) {
      const found = byKey.get(responsePageKey(spec.name))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.status_code ?? '') !== spec.statusCode) {
        diffs.push({ field: `${spec.name}.status_code`, expected: spec.statusCode, actual: found.status_code ?? '', severity: 'warning' })
      }
      if ((found.type ?? 'Error Pages') !== spec.type) {
        diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: found.type ?? 'Error Pages', severity: 'warning' })
      }
      if ((found.body ?? '') !== spec.body) {
        diffs.push({ field: `${spec.name}.body`, expected: 'matches declared body', actual: 'differs from declared body', severity: 'warning' })
      }
    }

    for (const page of live) {
      if (page.name && !declaredKeys.has(responsePageKey(page.name))) {
        diffs.push({ field: page.name, expected: 'not present (undeclared)', actual: 'present', severity: 'warning' })
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
