import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient } from '../../lib/oneLogin'
import { listBrands } from './deploy'
import { extractBrandSpecs } from './validate'

/**
 * Detect drift between the deployed brand configuration and the live
 * account. Re-finds each declared brand by NAME and diffs every managed
 * field. `master` and any asset fields (logo/background) are never compared
 * - they are outside this config type's writable surface (see canvas.yaml).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractBrandSpecs(ctx.deployedConfig).filter((s) => s.name)

  let brands
  try {
    brands = await listBrands(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'onelogin-account',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  for (const spec of specs) {
    const live = brands.find((b) => b.name === spec.name) ?? null
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const checks: Array<[string, unknown, unknown, 'info' | 'warning' | 'critical']> = [
      ['enabled', spec.enabled, live.enabled ?? true, 'critical'],
      ['customColor', spec.customColor ?? 'not set', live.custom_color ?? 'not set', 'warning'],
      ['customAccentColor', spec.customAccentColor ?? 'not set', live.custom_accent_color ?? 'not set', 'warning'],
      ['customMaskingColor', spec.customMaskingColor ?? 'not set', live.custom_masking_color ?? 'not set', 'info'],
      ['customMaskingOpacity', spec.customMaskingOpacity ?? 'not set', live.custom_masking_opacity ?? 'not set', 'info'],
      [
        'enableCustomLabelForLoginScreen',
        spec.enableCustomLabelForLoginScreen,
        live.enable_custom_label_for_login_screen ?? false,
        'warning',
      ],
      [
        'customLabelTextForLoginScreen',
        spec.customLabelTextForLoginScreen ?? 'not set',
        live.custom_label_text_for_login_screen ?? 'not set',
        'info',
      ],
      ['loginInstructionTitle', spec.loginInstructionTitle ?? 'not set', live.login_instruction_title ?? 'not set', 'info'],
      ['loginInstruction', spec.loginInstruction ?? 'not set', live.login_instruction ?? 'not set', 'info'],
      ['hideOneloginFooter', spec.hideOneloginFooter, live.hide_onelogin_footer ?? false, 'warning'],
      ['mfaEnrollmentMessage', spec.mfaEnrollmentMessage ?? 'not set', live.mfa_enrollment_message ?? 'not set', 'info'],
      ['customSupportEnabled', spec.customSupportEnabled, live.custom_support_enabled ?? false, 'warning'],
    ]

    for (const [field, expected, actual, severity] of checks) {
      if (expected !== actual) {
        diffs.push({ field: `${spec.name}.${field}`, expected, actual, severity })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
