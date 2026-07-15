import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listTemplates } from './deploy'
import { extractDlpTemplateSpecs } from './validate'

/**
 * Detect drift between the deployed DLP notification template configuration and
 * the live tenant. Re-finds each declared template by name and diffs the managed
 * scalar fields (subject, tlsEnabled, attachContent); a missing template is
 * critical drift. The message bodies are not diffed — ZIA server-normalizes
 * whitespace and HTML, which makes a scalar diff far too noisy.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDlpTemplateSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listTemplates(client)
    const byName = new Map(live.filter((t) => t.name).map((t) => [t.name as string, t]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveSubject = (typeof found.subject === 'string' ? found.subject : '').trim()
      if (spec.subject !== liveSubject) {
        diffs.push({
          field: `${spec.name}.subject`,
          expected: spec.subject || 'not set',
          actual: liveSubject || 'not set',
          severity: 'info',
        })
      }

      const liveTls = found.tlsEnabled === true
      if (spec.tlsEnabled !== liveTls) {
        diffs.push({
          field: `${spec.name}.tlsEnabled`,
          expected: String(spec.tlsEnabled),
          actual: String(liveTls),
          severity: 'info',
        })
      }

      const liveAttach = found.attachContent === true
      if (spec.attachContent !== liveAttach) {
        diffs.push({
          field: `${spec.name}.attachContent`,
          expected: String(spec.attachContent),
          actual: String(liveAttach),
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
