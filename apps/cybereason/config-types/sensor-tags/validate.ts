import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CUSTOM_TAGS_MAX_LENGTH, normalizeCriticalAsset } from './_shared'

const STRING_TAG_FIELDS: Array<{ key: 'department' | 'location' | 'deviceType' | 'customTags'; label: string }> = [
  { key: 'department', label: 'Department' },
  { key: 'location', label: 'Location' },
  { key: 'deviceType', label: 'Device type' },
  { key: 'customTags', label: 'Custom tags' },
]

/**
 * Validate sensor-tag items: a non-empty `pylumId` (the identity Cybereason's
 * tagging API keys on, so a duplicate is flagged — last one wins), each string
 * tag capped at 100 characters (mirroring Cybereason's own client-side cap on
 * `custom tags`), and `criticalAsset` restricted to its tri-state values
 * ('' | 'true' | 'false'). Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one sensor tag set.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const pylumId = String(item.fields.pylumId ?? '').trim()

    if (!pylumId) {
      errors.push({ field: `items[${i}].pylumId`, message: 'Sensor pylumId is required.', code: 'EMPTY_PYLUM_ID' })
    } else {
      if (seen.has(pylumId)) {
        warnings.push({ field: `items[${i}].pylumId`, message: `pylumId ${pylumId} is listed more than once; the last one wins.`, code: 'DUPLICATE_PYLUM_ID' })
      } else {
        seen.add(pylumId)
      }
    }

    for (const { key, label } of STRING_TAG_FIELDS) {
      const value = String(item.fields[key] ?? '').trim()
      if (value.length > CUSTOM_TAGS_MAX_LENGTH) {
        errors.push({
          field: `items[${i}].${key}`,
          message: `${label} must be ${CUSTOM_TAGS_MAX_LENGTH} characters or fewer (Cybereason's own limit).`,
          code: 'TAG_TOO_LONG',
        })
      }
    }

    const rawCritical = item.fields.criticalAsset
    if (rawCritical !== undefined && rawCritical !== null && String(rawCritical).trim() !== '') {
      const tri = normalizeCriticalAsset(rawCritical)
      if (tri === '') {
        errors.push({
          field: `items[${i}].criticalAsset`,
          message: `Critical asset must be left blank, "true" or "false" (got "${rawCritical}").`,
          code: 'INVALID_CRITICAL_ASSET',
        })
      }
    }

    const allBlank =
      !String(item.fields.department ?? '').trim() &&
      !String(item.fields.location ?? '').trim() &&
      !String(item.fields.deviceType ?? '').trim() &&
      !String(item.fields.customTags ?? '').trim() &&
      normalizeCriticalAsset(item.fields.criticalAsset) === ''
    if (pylumId && allBlank) {
      warnings.push({
        field: `items[${i}]`,
        message: 'No tag fields are set — deploying this item removes every tag from the sensor.',
        code: 'ALL_TAGS_BLANK',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
