import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { findPolicy, getPolicyDetail } from './deploy'
import { extractPolicySpecs } from './validate'

/**
 * Detect drift between the deployed scan-policy configuration and the live tenant
 * state. Looks up each declared policy by name, reads its detail, and diffs the
 * managed identity fields — the editor template uuid and, when the canvas sets
 * one, the description.
 *
 * The optional advanced `settingsJson` is deliberately NOT drift-checked: the
 * live GET /policies/{id} detail returns the full, template-expanded editor
 * object (hundreds of fields the template itself supplies), so a key-by-key diff
 * of a small user-supplied subset against it would report constant phantom drift.
 * Name is the lookup key, so it is not diffed here.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findPolicy(client, spec.name)

      if (!live || live.id === undefined) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const detail = await getPolicyDetail(client, live.id)

      // Template uuid — the editor template the policy is built from. The list
      // summary carries `template_uuid`; the detail carries `uuid`.
      const liveTemplateUuid = (detail?.uuid ?? live.template_uuid ?? '').toLowerCase()
      if (liveTemplateUuid && liveTemplateUuid !== spec.templateUuid.toLowerCase()) {
        diffs.push({
          field: `${spec.name}.templateUuid`,
          expected: spec.templateUuid,
          actual: detail?.uuid ?? live.template_uuid ?? 'not set',
          severity: 'warning',
        })
      }

      // Description — only compared when the canvas manages one (otherwise it may
      // be supplied by settingsJson or the template, which we do not diff).
      if (spec.description !== undefined) {
        const liveDescription =
          typeof detail?.settings?.description === 'string' ? detail.settings.description.trim() : ''
        if (spec.description !== liveDescription) {
          diffs.push({
            field: `${spec.name}.description`,
            expected: spec.description || 'not set',
            actual: liveDescription || 'not set',
            severity: 'info',
          })
        }
      }
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
