import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { findMethodByName } from './deploy'
import { extractMfaMethodSpecs, type LiveMfaMethod, type MfaMethodSpec, type MfaMethodType } from './validate'

/**
 * Detect drift between the deployed MFA method configuration and the live
 * cluster. Each method is re-found by its `method_name` LABEL (the same
 * reconciliation deploy uses — a method has no addressable name), then only the
 * NON-SECRET authored fields are diffed.
 *
 * WRITE-ONLY SECRETS ARE NEVER DIFFED — READ THIS BEFORE ADDING A FIELD:
 * duo `integration_key` + `secret_key`, okta `api_token` and pingid
 * `settings_file_base64` are WRITE-ONLY. Vault NEVER returns them on GET, so
 * there is nothing to compare against — any "diff" of a secret would compare the
 * canvas value to `undefined` and always report false drift. They are therefore
 * DELIBERATELY excluded from every comparison below. pingid's derived read-only
 * fields (idp_url, admin_url, …) are likewise NOT authored and NOT diffed. totp
 * has no secret, so its config is fully diffable.
 *
 * Severities: a missing method is `critical`; a changed non-secret field is
 * `warning` (it converges on the next deploy).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractMfaMethodSpecs(ctx.deployedConfig).filter((s) => s.methodName && s.type)

  for (const spec of specs) {
    const type = spec.type as MfaMethodType
    const label = spec.methodName
    try {
      const live = await findMethodByName(client, type, spec.methodName)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Diff ONLY the non-secret authored fields for this type. Secrets are
      // never read back and are intentionally excluded (see the file header).
      for (const [field, expected, actual] of diffableFields(spec, live)) {
        if (!valuesEqual(expected, actual)) {
          diffs.push({
            field: `${label}.${field}`,
            expected: expected ?? 'not set',
            actual: actual ?? 'not set',
            severity: 'warning',
          })
        }
      }
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/**
 * The [fieldLabel, expected, liveActual] triples to compare for a type. NONE of
 * these is a secret — integration_key / secret_key / api_token /
 * settings_file_base64 are absent by design.
 */
function diffableFields(
  spec: MfaMethodSpec,
  live: LiveMfaMethod,
): Array<[string, string | undefined, string | undefined]> {
  switch (spec.type) {
    case 'totp':
      return [
        ['issuer', spec.issuer, str(live.issuer)],
        ['period', num(spec.period), num(live.period)],
        ['keySize', num(spec.keySize), num(live.key_size)],
        ['algorithm', spec.algorithm, str(live.algorithm)],
        ['digits', num(spec.digits), num(live.digits)],
        ['skew', num(spec.skew), num(live.skew)],
        ['maxValidationAttempts', num(spec.maxValidationAttempts), num(live.max_validation_attempts)],
      ]
    case 'duo':
      return [
        ['apiHostname', spec.apiHostname, str(live.api_hostname)],
        ['usernameFormat', spec.usernameFormat, str(live.username_format)],
        ['pushInfo', spec.pushInfo, str(live.push_info)],
        ['usePasscode', bool(spec.usePasscode), bool(live.use_passcode)],
      ]
    case 'okta':
      return [
        ['orgName', spec.orgName, str(live.org_name)],
        ['baseUrl', spec.baseUrl, str(live.base_url)],
        ['usernameFormat', spec.usernameFormat, str(live.username_format)],
        ['primaryEmail', bool(spec.primaryEmail), bool(live.primary_email)],
      ]
    case 'pingid':
      // Only username_format is an authored non-secret field. The settings file
      // is a write-only secret and the idp_url/admin_url/... are derived.
      return [['usernameFormat', spec.usernameFormat, str(live.username_format)]]
    default:
      return []
  }
}

/** Two optional strings are equal when they carry the same non-empty value. */
function valuesEqual(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '') === (b ?? '')
}

/** Normalize a live string field for comparison (blank → undefined). */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Normalize a numeric field (spec number or live number/string) to a string. */
function num(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? String(n) : undefined
}

/** Normalize a boolean field to a stable "true"/"false" string. */
function bool(value: boolean | undefined): string {
  return value ? 'true' : 'false'
}
