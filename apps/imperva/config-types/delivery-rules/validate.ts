import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  classifyDelivery,
  readDeliveryFields,
  DELIVERY_ACTIONS,
  REDIRECT_RESPONSE_CODES,
  CUSTOM_ERROR_RESPONSE_CODES,
  ERROR_TYPES,
  ERROR_RESPONSE_FORMATS,
  RATE_CONTEXTS,
  PORT_FORWARDING_CONTEXTS,
} from './_shared'

/**
 * Validate delivery rule items: a numeric Site ID, a non-empty name (≤255
 * chars), a known delivery action, and the parameters that action's kind
 * requires. Static — no target access required. The rule NAME is the identity
 * WITHIN a site (same as ACL Rules, since both share the IncapRules resource),
 * so a duplicate (siteId, name) pair is flagged.
 */
const SITE_ID_RE = /^[0-9]+$/
const RATE_INTERVAL_RE = /^[0-9]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one delivery rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = readDeliveryFields(item.fields)
    const p = (field: string) => `items[${i}].${field}`

    if (!f.siteId) {
      errors.push({ field: p('siteId'), message: 'Site ID is required.', code: 'EMPTY_SITE_ID' })
    } else if (!SITE_ID_RE.test(f.siteId)) {
      errors.push({ field: p('siteId'), message: `Site ID "${f.siteId}" must be numeric.`, code: 'INVALID_SITE_ID' })
    }

    if (!f.name) {
      errors.push({ field: p('name'), message: 'Rule name is required.', code: 'EMPTY_NAME' })
    } else if (f.name.length > 255) {
      errors.push({ field: p('name'), message: 'Rule name must be 255 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else if (f.siteId) {
      const key = `${f.siteId}::${f.name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({ field: p('name'), message: `Rule "${f.name}" is listed more than once for site ${f.siteId}; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    const kind = classifyDelivery(f.action)
    if (!f.action) {
      errors.push({ field: p('action'), message: 'A delivery action is required.', code: 'EMPTY_ACTION' })
    } else if (!DELIVERY_ACTIONS.has(f.action) || !kind) {
      errors.push({
        field: p('action'),
        message: `Action "${f.action}" is not a supported delivery action. Use one of: ${[...DELIVERY_ACTIONS].join(', ')}.`,
        code: 'INVALID_ACTION',
      })
    }

    if (f.action !== 'RULE_ACTION_SIMPLIFIED_REDIRECT' && !f.filter) {
      warnings.push({ field: p('filter'), message: `Rule "${f.name || i}" has an empty filter — the action will run on EVERY request to site ${f.siteId || '(unset)'}.`, code: 'EMPTY_FILTER' })
    }

    switch (kind) {
      case 'redirect':
        // RULE_ACTION_SIMPLIFIED_REDIRECT ignores "from" (and filter) — it redirects
        // every request on the site straight to "to", no match condition needed.
        if (f.action === 'RULE_ACTION_REDIRECT' && !f.from) {
          errors.push({ field: p('from'), message: 'A "from" URL is required for a (non-simplified) redirect.', code: 'EMPTY_FROM' })
        }
        if (!f.to) errors.push({ field: p('to'), message: 'A "to" URL is required for a redirect.', code: 'EMPTY_TO' })
        if (f.response_code && !REDIRECT_RESPONSE_CODES.has(f.response_code)) {
          errors.push({ field: p('response_code'), message: `Response code "${f.response_code}" must be one of: ${[...REDIRECT_RESPONSE_CODES].join(', ')}.`, code: 'INVALID_RESPONSE_CODE' })
        }
        break
      case 'rewrite_url':
        if (!f.from) errors.push({ field: p('from'), message: 'A "from" URL pattern is required to rewrite a URL.', code: 'EMPTY_FROM' })
        if (!f.to) errors.push({ field: p('to'), message: 'A "to" URL is required to rewrite a URL.', code: 'EMPTY_TO' })
        break
      case 'rewrite_header_cookie':
        if (!f.rewrite_name) errors.push({ field: p('rewrite_name'), message: 'A header/cookie name is required.', code: 'EMPTY_REWRITE_NAME' })
        if (!f.to) errors.push({ field: p('to'), message: 'A "to" value is required to rewrite a header/cookie.', code: 'EMPTY_TO' })
        break
      case 'delete_header_cookie':
        if (!f.rewrite_name) errors.push({ field: p('rewrite_name'), message: 'A header/cookie name is required to delete it.', code: 'EMPTY_REWRITE_NAME' })
        break
      case 'response_rewrite_code':
        if (!f.response_code) {
          errors.push({ field: p('response_code'), message: 'A response code is required.', code: 'EMPTY_RESPONSE_CODE' })
        } else if (!/^[0-9]{3}$/.test(f.response_code)) {
          errors.push({ field: p('response_code'), message: `Response code "${f.response_code}" must be a 3-digit number.`, code: 'INVALID_RESPONSE_CODE' })
        }
        break
      case 'forward_dc':
        if (!f.dc_id) errors.push({ field: p('dc_id'), message: 'A data center id is required to forward to a data center.', code: 'EMPTY_DC_ID' })
        break
      case 'forward_port':
        if (!f.port_forwarding_context || !PORT_FORWARDING_CONTEXTS.has(f.port_forwarding_context)) {
          errors.push({ field: p('port_forwarding_context'), message: `Port forwarding context must be one of: ${[...PORT_FORWARDING_CONTEXTS].join(', ')}.`, code: 'INVALID_PORT_FORWARDING_CONTEXT' })
        }
        if (!f.port_forwarding_value) errors.push({ field: p('port_forwarding_value'), message: 'A port number or header name is required.', code: 'EMPTY_PORT_FORWARDING_VALUE' })
        break
      case 'rate':
        if (!f.rate_context || !RATE_CONTEXTS.has(f.rate_context)) {
          errors.push({ field: p('rate_context'), message: `Rate context must be one of: ${[...RATE_CONTEXTS].join(', ')}.`, code: 'INVALID_RATE_CONTEXT' })
        }
        if (!f.rate_interval) {
          errors.push({ field: p('rate_interval'), message: 'A rate interval (seconds) is required.', code: 'EMPTY_RATE_INTERVAL' })
        } else if (!RATE_INTERVAL_RE.test(f.rate_interval) || Number(f.rate_interval) < 10 || Number(f.rate_interval) > 300 || Number(f.rate_interval) % 10 !== 0) {
          errors.push({ field: p('rate_interval'), message: 'Rate interval must be a multiple of 10, between 10 and 300 seconds.', code: 'INVALID_RATE_INTERVAL' })
        }
        break
      case 'custom_error':
        if (!f.response_code || !CUSTOM_ERROR_RESPONSE_CODES.has(f.response_code)) {
          errors.push({ field: p('response_code'), message: `Response code "${f.response_code}" is not a supported custom error status code.`, code: 'INVALID_RESPONSE_CODE' })
        }
        if (!f.error_type || !ERROR_TYPES.has(f.error_type)) {
          errors.push({ field: p('error_type'), message: `Error type must be one of: ${[...ERROR_TYPES].join(', ')}.`, code: 'INVALID_ERROR_TYPE' })
        }
        if (f.error_response_format && !ERROR_RESPONSE_FORMATS.has(f.error_response_format)) {
          errors.push({ field: p('error_response_format'), message: 'Error response format must be "json" or "xml".', code: 'INVALID_ERROR_RESPONSE_FORMAT' })
        }
        if (!f.error_response_data) {
          warnings.push({ field: p('error_response_data'), message: 'No custom error response body set — Imperva will use its default for the format.', code: 'EMPTY_ERROR_RESPONSE_DATA' })
        }
        break
      default:
        break
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
