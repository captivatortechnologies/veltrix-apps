import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findSmsTemplate } from './deploy'
import { extractSmsTemplateSpecs, parseTranslations } from './validate'

/**
 * Detect drift between the deployed SMS-template configuration and the live Okta
 * org. Each declared template is re-found by name and its meaningful fields are
 * compared:
 *   - template body — a defining field (critical).
 *   - translations  — compared order-insensitively (warning).
 * Server-managed readOnly fields (id, created, lastUpdated, _links) are never
 * modeled so they cannot read as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSmsTemplateSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findSmsTemplate(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // template body — the defining field.
      const liveTemplate = (live.template ?? '').toString()
      if (spec.template !== liveTemplate) {
        diffs.push({
          field: `${spec.name}.template`,
          expected: spec.template,
          actual: liveTemplate || 'not set',
          severity: 'critical',
        })
      }

      // translations — compare order-insensitively; an absent/invalid declared
      // blob is treated as no translations.
      const declared = spec.translationsJson ? parseTranslations(spec.translationsJson) : {}
      const expectedTranslations = declared ?? {}
      const liveTranslations =
        live.translations && typeof live.translations === 'object' ? live.translations : {}
      if (stableStringify(expectedTranslations) !== stableStringify(liveTranslations)) {
        diffs.push({
          field: `${spec.name}.translations`,
          expected: expectedTranslations,
          actual: liveTranslations,
          severity: 'warning',
        })
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

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
