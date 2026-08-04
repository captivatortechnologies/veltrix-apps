import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  ACCELERATION_LEVELS,
  ACTIVE_VALUES,
  BOOL_STRINGS,
  DOMAIN_VALIDATION_VALUES,
  LOG_LEVELS,
  readSiteConfigFields,
  SEAL_LOCATIONS,
} from './_shared'

/**
 * Validate site configuration items: a numeric Site ID and, for every declared
 * (non-empty) field, a value from its known enum. Static — no target access
 * required. A site's general configuration is a SINGLETON, so a duplicate Site
 * ID across items is flagged (last one wins on deploy).
 */
const SITE_ID_RE = /^[0-9]+$/
const APPROVER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one site configuration.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = readSiteConfigFields(item.fields)
    const p = (field: string) => `items[${i}].${field}`

    if (!f.siteId) {
      errors.push({ field: p('siteId'), message: 'Site ID is required.', code: 'EMPTY_SITE_ID' })
    } else if (!SITE_ID_RE.test(f.siteId)) {
      errors.push({ field: p('siteId'), message: `Site ID "${f.siteId}" must be numeric.`, code: 'INVALID_SITE_ID' })
    } else {
      if (seen.has(f.siteId)) {
        warnings.push({ field: p('siteId'), message: `Site ${f.siteId} is configured more than once; the last one wins.`, code: 'DUPLICATE_SITE' })
      } else {
        seen.add(f.siteId)
      }
    }

    if (f.active && !ACTIVE_VALUES.has(f.active)) {
      errors.push({ field: p('active'), message: 'Active must be "active" or "bypass".', code: 'INVALID_ACTIVE' })
    }
    if (f.domainValidation && !DOMAIN_VALIDATION_VALUES.has(f.domainValidation)) {
      errors.push({ field: p('domainValidation'), message: `Domain validation must be one of: ${[...DOMAIN_VALIDATION_VALUES].join(', ')}.`, code: 'INVALID_DOMAIN_VALIDATION' })
    }
    if (f.approver && !APPROVER_EMAIL_RE.test(f.approver)) {
      errors.push({ field: p('approver'), message: `Approver "${f.approver}" does not look like an email address.`, code: 'INVALID_APPROVER' })
    }
    if (f.ignoreSsl && !BOOL_STRINGS.has(f.ignoreSsl)) {
      errors.push({ field: p('ignoreSsl'), message: 'Ignore SSL must be "true" or "false".', code: 'INVALID_IGNORE_SSL' })
    }
    if (f.accelerationLevel && !ACCELERATION_LEVELS.has(f.accelerationLevel)) {
      errors.push({ field: p('accelerationLevel'), message: `Acceleration level must be one of: ${[...ACCELERATION_LEVELS].join(', ')}.`, code: 'INVALID_ACCELERATION_LEVEL' })
    }
    if (f.sealLocation && !SEAL_LOCATIONS.has(f.sealLocation)) {
      errors.push({ field: p('sealLocation'), message: `Seal location must be one of: ${[...SEAL_LOCATIONS].join(', ')}.`, code: 'INVALID_SEAL_LOCATION' })
    }
    if (f.restrictedCnameReuse && !BOOL_STRINGS.has(f.restrictedCnameReuse)) {
      errors.push({ field: p('restrictedCnameReuse'), message: 'Restricted CNAME reuse must be "true" or "false".', code: 'INVALID_RESTRICTED_CNAME_REUSE' })
    }
    if (f.domainRedirectToFull && !BOOL_STRINGS.has(f.domainRedirectToFull)) {
      errors.push({ field: p('domainRedirectToFull'), message: 'Domain redirect to full must be "true" or "false".', code: 'INVALID_DOMAIN_REDIRECT' })
    }
    if (f.nakedDomainSan && !BOOL_STRINGS.has(f.nakedDomainSan)) {
      errors.push({ field: p('nakedDomainSan'), message: 'Naked domain SAN must be "true" or "false".', code: 'INVALID_NAKED_DOMAIN_SAN' })
    }
    if (f.wildcardSan && !BOOL_STRINGS.has(f.wildcardSan)) {
      errors.push({ field: p('wildcardSan'), message: 'Wildcard SAN must be "true" or "false".', code: 'INVALID_WILDCARD_SAN' })
    }
    if (f.refId && f.refId.length > 255) {
      errors.push({ field: p('refId'), message: 'Reference ID must be 255 characters or fewer.', code: 'REF_ID_TOO_LONG' })
    }
    if (f.logLevel && !LOG_LEVELS.has(f.logLevel)) {
      errors.push({ field: p('logLevel'), message: `Log level must be one of: ${[...LOG_LEVELS].join(', ')}.`, code: 'INVALID_LOG_LEVEL' })
    }

    const hasAnySetting =
      f.active || f.domainValidation || f.approver || f.ignoreSsl || f.accelerationLevel || f.sealLocation ||
      f.restrictedCnameReuse || f.domainRedirectToFull || f.refId || f.nakedDomainSan || f.wildcardSan || f.logLevel
    if (f.siteId && !hasAnySetting) {
      warnings.push({ field: p('siteId'), message: 'No settings declared for this site — deploy would be a no-op.', code: 'NO_SETTINGS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
