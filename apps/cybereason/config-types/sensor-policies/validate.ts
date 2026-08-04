import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidJsonObject, parseConfigurationBlob, checkKnownEnums } from './_shared'

/**
 * Validate sensor-policy items: a non-empty name (the upsert identity, so a
 * duplicate is flagged — last one wins) and a `configuration` blob that is
 * either blank or a valid JSON object. The small set of well-known,
 * live-tenant-confirmed enum fields inside `configuration` (anti-malware detect
 * / prevent mode, anti-exploit mode, ARW mode / level, rules-engine mode) are
 * checked when present; the rest of this large, deeply-nested schema is not
 * deep-validated here — Cybereason validates it at deploy time. Static — no
 * target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one sensor policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const configuration = item.fields.configuration

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Policy ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!isValidJsonObject(configuration)) {
      errors.push({
        field: `items[${i}].configuration`,
        message: 'Configuration must be valid JSON object (or left blank).',
        code: 'INVALID_CONFIGURATION',
      })
      return
    }

    try {
      const parsed = parseConfigurationBlob(configuration)
      for (const problem of checkKnownEnums(parsed)) {
        warnings.push({
          field: `items[${i}].configuration.${problem.path}`,
          message: `"${problem.path}" is "${problem.value}" — expected one of: ${problem.allowed}. Cybereason will reject an invalid value at deploy time.`,
          code: 'UNKNOWN_ENUM_VALUE',
        })
      }
    } catch {
      // isValidJsonObject already gated this — unreachable in practice.
    }
  })

  if (items.length > 0) {
    warnings.push({
      field: 'items',
      message:
        'Updating an EXISTING policy uses PUT /rest/policies/{id}, which is inferred from Cybereason\'s Groups ' +
        'endpoint and is not independently confirmed (see _shared.ts). Deploy surfaces a clear failure rather than ' +
        'silently no-op-ing if a tenant rejects it — verify this against your tenant before relying on it in production.',
      code: 'POLICY_UPDATE_UNVERIFIED',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
