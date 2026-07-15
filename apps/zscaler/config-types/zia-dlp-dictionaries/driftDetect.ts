import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listDlpDictionaries } from './deploy'
import { extractDlpDictionarySpecs } from './validate'

/**
 * Detect drift between the deployed DLP dictionary configuration and the live
 * tenant. Re-finds each declared dictionary by name and diffs the managed
 * scalar fields (description) plus the phrase/pattern counts; a missing
 * dictionary is critical drift. Individual phrase/pattern text is not deep-
 * diffed — ZIA normalises and re-orders entries server-side, so a count diff is
 * the reliable signal that the set changed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDlpDictionarySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listDlpDictionaries(client)
    const byName = new Map(live.filter((d) => d.name).map((d) => [d.name as string, d]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveDescription = (typeof found.description === 'string' ? found.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      const livePhraseCount = Array.isArray(found.phrases) ? found.phrases.length : 0
      if (spec.phrases.length !== livePhraseCount) {
        diffs.push({
          field: `${spec.name}.phrases`,
          expected: `${spec.phrases.length} phrase(s)`,
          actual: `${livePhraseCount} phrase(s)`,
          severity: 'info',
        })
      }

      const livePatternCount = Array.isArray(found.patterns) ? found.patterns.length : 0
      if (spec.patterns.length !== livePatternCount) {
        diffs.push({
          field: `${spec.name}.patterns`,
          expected: `${spec.patterns.length} pattern(s)`,
          actual: `${livePatternCount} pattern(s)`,
          severity: 'info',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'zia',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
