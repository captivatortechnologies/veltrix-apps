import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findBrand, getBrandTheme } from './deploy'
import { extractBrandSpecs, hasThemeChange, parseConfigObject, THEME_COLOR_FIELDS } from './validate'

/**
 * Detect drift between the deployed brand configuration and the live Okta org.
 * Each declared brand is re-found by name and its meaningful fields are compared:
 *   - brand settings (removePoweredByOkta, custom privacy URL, locale, email domain)
 *   - theme colours + any declared touchpoint variants (only when the canvas
 *     declares a theme change)
 *
 * Server-managed fields (id, isDefault, _links, _embedded, logos) are never modeled
 * so they cannot read as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractBrandSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findBrand(client, spec.name)
      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // brand settings
      if ((live.removePoweredByOkta ?? false) !== spec.removePoweredByOkta) {
        diffs.push({
          field: `${spec.name}.removePoweredByOkta`,
          expected: spec.removePoweredByOkta,
          actual: live.removePoweredByOkta ?? false,
          severity: 'warning',
        })
      }
      if (spec.customPrivacyPolicyUrl && (live.customPrivacyPolicyUrl ?? '') !== spec.customPrivacyPolicyUrl) {
        diffs.push({
          field: `${spec.name}.customPrivacyPolicyUrl`,
          expected: spec.customPrivacyPolicyUrl,
          actual: live.customPrivacyPolicyUrl ?? 'not set',
          severity: 'warning',
        })
      }
      if (spec.locale && (live.locale ?? '') !== spec.locale) {
        diffs.push({
          field: `${spec.name}.locale`,
          expected: spec.locale,
          actual: live.locale ?? 'not set',
          severity: 'warning',
        })
      }
      if (spec.emailDomainId && (live.emailDomainId ?? '') !== spec.emailDomainId) {
        diffs.push({
          field: `${spec.name}.emailDomainId`,
          expected: spec.emailDomainId,
          actual: live.emailDomainId ?? 'not set',
          severity: 'warning',
        })
      }

      // theme — only when the canvas declares a theme change
      if (hasThemeChange(spec) && live.id) {
        const theme = await getBrandTheme(client, live.id)
        for (const [fieldKey, themeProp] of THEME_COLOR_FIELDS) {
          const expected = spec[fieldKey]
          if (expected === undefined) continue
          const actual = theme ? (theme[themeProp] as string | undefined) : undefined
          if ((actual ?? '').toLowerCase() !== expected.toLowerCase()) {
            diffs.push({
              field: `${spec.name}.${fieldKey}`,
              expected,
              actual: actual ?? 'not set',
              severity: 'warning',
            })
          }
        }
        const config = spec.themeConfigJson ? parseConfigObject(spec.themeConfigJson) : {}
        if (config && theme) {
          for (const key of Object.keys(config)) {
            const expected = String(config[key] ?? '')
            const actual = String(theme[key] ?? '')
            if (expected !== actual) {
              diffs.push({
                field: `${spec.name}.${key}`,
                expected: config[key] ?? 'not set',
                actual: theme[key] ?? 'not set',
                severity: 'warning',
              })
            }
          }
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
