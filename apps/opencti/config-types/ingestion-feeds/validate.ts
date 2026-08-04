import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { TAXII_AUTH_TYPES, TAXII_AUTH_TYPES_WITH_VALUE, TAXII_VERSIONS } from './_shared'

/**
 * Validate TAXII2 ingestion-feed items: a name, an http(s) URI, a collection, a
 * known TAXII version and auth type, an optional date, and — for auth types that
 * need it — an authentication value (warning if missing, since it may already be
 * stored on an existing feed). Static — no target access required. The name doubles
 * as the feed identity, so a duplicate is flagged (last one wins).
 */
const URL_RE = /^https?:\/\/.+/
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one ingestion feed.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const uri = String(item.fields.uri ?? '').trim()
    const collection = String(item.fields.collection ?? '').trim()
    const version = String(item.fields.version ?? '').trim()
    const authType = String(item.fields.authentication_type ?? '').trim()
    const authValue = String(item.fields.authentication_value ?? '').trim()
    const addedAfter = String(item.fields.added_after_start ?? '').trim()
    const userId = String(item.fields.user_id ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Feed name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Feed "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!uri) {
      errors.push({ field: `items[${i}].uri`, message: 'TAXII2 root URL is required.', code: 'EMPTY_URI' })
    } else if (!URL_RE.test(uri)) {
      errors.push({ field: `items[${i}].uri`, message: `URL "${uri}" must start with http:// or https://.`, code: 'INVALID_URI' })
    }

    if (!collection) {
      errors.push({ field: `items[${i}].collection`, message: 'Collection is required.', code: 'EMPTY_COLLECTION' })
    }

    if (!userId) {
      errors.push({
        field: `items[${i}].user_id`,
        message: 'OpenCTI User ID is required — IngestionTaxiiAddInput.user_id is a required field.',
        code: 'EMPTY_USER_ID',
      })
    }

    if (!TAXII_VERSIONS.has(version)) {
      errors.push({
        field: `items[${i}].version`,
        message: `TAXII version must be one of v21, v20 (got "${version}").`,
        code: 'INVALID_VERSION',
      })
    }

    if (!TAXII_AUTH_TYPES.has(authType)) {
      errors.push({
        field: `items[${i}].authentication_type`,
        message: `Authentication type must be one of none, basic, bearer, certificate (got "${authType}").`,
        code: 'INVALID_AUTH_TYPE',
      })
    } else if (TAXII_AUTH_TYPES_WITH_VALUE.has(authType) && !authValue) {
      warnings.push({
        field: `items[${i}].authentication_value`,
        message: `Authentication type "${authType}" usually needs an authentication value; leave blank only if the feed already has one stored.`,
        code: 'MISSING_AUTH_VALUE',
      })
    }

    if (addedAfter && !DATE_RE.test(addedAfter)) {
      errors.push({
        field: `items[${i}].added_after_start`,
        message: `Import-from date "${addedAfter}" must be ISO-8601 (e.g. 2024-01-01).`,
        code: 'INVALID_DATE',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
