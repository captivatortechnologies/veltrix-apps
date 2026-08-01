import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { IOC_TYPES, IOC_SEVERITIES, IOC_REPUTATIONS, IOC_RELIABILITIES } from './_shared'

/**
 * Validate IOC items: a non-empty indicator value, a known type + severity, and —
 * when provided — a known reputation / reliability and a positive-integer epoch
 * expiration. Static — no target access required. The indicator value doubles as
 * the IOC identity, so a duplicate value is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one indicator.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const indicator = String(item.fields.indicator ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const severity = String(item.fields.severity ?? '').trim()
    const reputation = String(item.fields.reputation ?? '').trim()
    const reliability = String(item.fields.reliability ?? '').trim()
    const expiration = String(item.fields.expiration_date ?? '').trim()

    if (!indicator) {
      errors.push({ field: `items[${i}].indicator`, message: 'Indicator value is required.', code: 'EMPTY_INDICATOR' })
    } else {
      const key = indicator.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].indicator`, message: `Indicator ${indicator} is listed more than once; the last one wins.`, code: 'DUPLICATE_INDICATOR' })
      } else {
        seen.add(key)
      }
    }

    if (!IOC_TYPES.has(type)) {
      errors.push({ field: `items[${i}].type`, message: `Type must be one of HASH, IP, DOMAIN_NAME, PATH, FILENAME (got "${type}").`, code: 'INVALID_TYPE' })
    }

    if (!IOC_SEVERITIES.has(severity)) {
      errors.push({ field: `items[${i}].severity`, message: `Severity must be one of INFO, LOW, MEDIUM, HIGH, CRITICAL (got "${severity}").`, code: 'INVALID_SEVERITY' })
    }

    if (reputation && !IOC_REPUTATIONS.has(reputation)) {
      errors.push({ field: `items[${i}].reputation`, message: `Reputation must be one of GOOD, BAD, SUSPICIOUS, UNKNOWN (got "${reputation}").`, code: 'INVALID_REPUTATION' })
    }

    if (reliability && !IOC_RELIABILITIES.has(reliability)) {
      errors.push({ field: `items[${i}].reliability`, message: `Reliability must be a grade A–F (got "${reliability}").`, code: 'INVALID_RELIABILITY' })
    }

    if (expiration && !/^[0-9]+$/.test(expiration)) {
      errors.push({ field: `items[${i}].expiration_date`, message: `Expiration must be a Unix epoch timestamp in milliseconds (got "${expiration}").`, code: 'INVALID_EXPIRATION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
