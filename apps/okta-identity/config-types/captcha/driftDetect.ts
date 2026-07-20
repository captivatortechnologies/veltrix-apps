import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { getCaptchaInstance, getOrgCaptcha } from './deploy'
import { extractCaptchaSpecs } from './validate'

/**
 * Detect drift between the deployed CAPTCHA configuration and the live org.
 * Compares:
 *   - the instance name / provider / site key
 *   - the org-wide enabledPages (order-insensitive) and that the org references
 *     this instance
 *
 * secretKey is WRITE-ONLY and never modeled, so it can never read as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractCaptchaSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }
  const spec = specs[0]

  try {
    const instance = await getCaptchaInstance(client)
    if (!instance) {
      diffs.push({ field: 'captcha', expected: 'exists', actual: 'missing', severity: 'critical' })
      return { hasDrift: true, diffs }
    }

    if ((instance.name ?? '') !== spec.name) {
      diffs.push({ field: 'name', expected: spec.name, actual: instance.name ?? 'not set', severity: 'warning' })
    }
    const liveType = (instance.type ?? '').toString().toUpperCase()
    if (liveType !== spec.type) {
      diffs.push({ field: 'type', expected: spec.type, actual: liveType || 'not set', severity: 'critical' })
    }
    if ((instance.siteKey ?? '') !== spec.siteKey) {
      diffs.push({ field: 'siteKey', expected: spec.siteKey, actual: instance.siteKey ?? 'not set', severity: 'critical' })
    }

    // Org-wide enablement.
    const org = await getOrgCaptcha(client)
    const expectedPages = [...spec.enabledPages].sort()
    const livePages = Array.isArray(org?.enabledPages) ? [...org!.enabledPages!].map(String).sort() : []
    if (JSON.stringify(expectedPages) !== JSON.stringify(livePages)) {
      diffs.push({ field: 'enabledPages', expected: expectedPages, actual: livePages, severity: 'warning' })
    }
    // When pages are declared, the org should reference this exact instance.
    if (spec.enabledPages.length > 0 && instance.id && org?.captchaId !== instance.id) {
      diffs.push({
        field: 'org.captchaId',
        expected: instance.id,
        actual: org?.captchaId ?? 'not set',
        severity: 'critical',
      })
    }
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'captcha',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
