import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { text, parseExpirationSettings } from './_shared'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validate Organization items: a non-empty name is required (it doubles as the identity). The
 * parent id, if set, is loosely checked for UUID shape. The advanced expiration-settings blob, if
 * set, must be valid JSON — a hard error, since deploy would otherwise send a broken payload we
 * can cheaply catch client-side. Static — no target access required. A duplicate name is flagged
 * (last wins). Note the account-scope requirement is a deploy-time concern, surfaced by
 * healthCheck, not something validate can assert statically.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one organization.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = text(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Organization name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Organization name "${name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(name.toLowerCase())
    }

    const parentId = text(item.fields.parentId)
    if (parentId && !UUID_RE.test(parentId)) {
      warnings.push({
        field: `items[${i}].parentId`,
        message: `Parent organization id "${parentId}" does not look like a UUID — runZero may reject it.`,
        code: 'SUSPECT_PARENT_ID',
      })
    }

    const settingsRaw = text(item.fields.expirationSettingsJson)
    if (settingsRaw && parseExpirationSettings(settingsRaw) === null) {
      errors.push({
        field: `items[${i}].expirationSettingsJson`,
        message: 'Advanced expiration settings must be a valid JSON object.',
        code: 'INVALID_JSON',
      })
    }

    for (const [key, label] of [
      ['expirationAssetsStaleDays', 'Stale asset expiration'],
      ['expirationAssetsOfflineDays', 'Offline asset expiration'],
      ['expirationScansDays', 'Scan data expiration'],
    ] as const) {
      const raw = item.fields[key]
      if (raw === '' || raw === null || raw === undefined) continue
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) {
        warnings.push({
          field: `items[${i}].${key}`,
          message: `${label} should be a non-negative number of days.`,
          code: 'SUSPECT_EXPIRATION_DAYS',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
