import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  extractWebhookSubscriptionSpecs,
  parseCustomHeaders,
  parseEvents,
  VALID_FILTER_TYPES,
} from './_shared'

/**
 * Validate webhook subscription items. Static — no target access required:
 *   - description is required and unique across the canvas (this app's
 *     reconciliation identity — see _shared.ts on why, since PagerDuty's own
 *     model has no name field for this resource)
 *   - url is required and must be a well-formed http(s) URL
 *   - events must parse to a non-empty JSON array of known incident event types
 *   - filter_type must be one of account_reference / service_reference / team_reference
 *   - filter_target is required when filter_type needs a target
 *     (service_reference/team_reference); a non-blank filter_target under
 *     account_reference is a warning, not an error (it is simply not sent)
 *   - custom_headers, when supplied, must parse to a JSON array of
 *     { name, value } pairs
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractWebhookSubscriptionSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one webhook subscription.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({
        field: `${prefix}.description`,
        message: 'Description is required — this app uses it as the stable identity for upsert and drift.',
        code: 'EMPTY_DESCRIPTION',
      })
    } else if (seen.has(spec.description.toLowerCase())) {
      warnings.push({
        field: `${prefix}.description`,
        message: `Description "${spec.description}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_DESCRIPTION',
      })
    } else {
      seen.add(spec.description.toLowerCase())
    }

    if (!spec.url) {
      errors.push({ field: `${prefix}.url`, message: 'Delivery URL is required.', code: 'EMPTY_URL' })
    } else {
      try {
        const parsed = new URL(spec.url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push({ field: `${prefix}.url`, message: `Delivery URL "${spec.url}" must use http or https.`, code: 'INVALID_URL' })
        }
      } catch {
        errors.push({ field: `${prefix}.url`, message: `Delivery URL "${spec.url}" is not a well-formed URL.`, code: 'INVALID_URL' })
      }
    }

    const eventsParsed = parseEvents(spec.eventsJson)
    if (eventsParsed.error) {
      errors.push({ field: `${prefix}.events`, message: `Events ${eventsParsed.error}.`, code: 'INVALID_EVENTS' })
    }

    if (!spec.filterType) {
      errors.push({ field: `${prefix}.filter_type`, message: 'A filter type is required.', code: 'EMPTY_FILTER_TYPE' })
    } else if (!VALID_FILTER_TYPES.has(spec.filterType)) {
      errors.push({
        field: `${prefix}.filter_type`,
        message: `filter_type must be one of ${[...VALID_FILTER_TYPES].join(' / ')}.`,
        code: 'INVALID_FILTER_TYPE',
      })
    } else if (spec.filterType === 'account_reference') {
      if (spec.filterTarget) {
        warnings.push({
          field: `${prefix}.filter_target`,
          message: 'filter_target is ignored for an account_reference filter and will not be sent.',
          code: 'IGNORED_FILTER_TARGET',
        })
      }
    } else if (!spec.filterTarget) {
      errors.push({
        field: `${prefix}.filter_target`,
        message: `filter_target is required when filter_type is "${spec.filterType}".`,
        code: 'EMPTY_FILTER_TARGET',
      })
    }

    const headersParsed = parseCustomHeaders(spec.customHeadersJson)
    if (headersParsed.error) {
      errors.push({
        field: `${prefix}.custom_headers`,
        message: `Custom headers ${headersParsed.error}.`,
        code: 'INVALID_CUSTOM_HEADERS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
