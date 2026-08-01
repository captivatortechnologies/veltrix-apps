import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { DETECTION_CATEGORIES, normalizeBool, parseList } from './_shared'

/**
 * Validate triage-rule items. Static — no target access required.
 *   - description is required and doubles as the rule identity (duplicates warned).
 *   - detection_category must be a known category; detection type is required.
 *   - non-whitelist rules need a triage_category (where to re-file detections).
 *   - a rule scoped off "all hosts" must name at least one host ID or source IP.
 *   - IP / CIDR fields are shape-checked (loose — Vectra is the final authority).
 */
const IP_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/

function isIpOrCidr(value: string): boolean {
  const m = IP_CIDR_RE.exec(value)
  if (!m) return false
  if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return false
  if (m[5] && Number(m[5].slice(1)) > 32) return false
  return true
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one triage rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = item.fields
    const description = String(f.description ?? '').trim()
    const detectionCategory = String(f.detection_category ?? '').trim()
    const detection = String(f.detection ?? '').trim()
    const triageCategory = String(f.triage_category ?? '').trim()
    const isWhitelist = normalizeBool(f.is_whitelist)
    const allHosts = normalizeBool(f.all_hosts)

    if (!description) {
      errors.push({ field: `items[${i}].description`, message: 'Rule description is required.', code: 'EMPTY_DESCRIPTION' })
    } else if (seen.has(description)) {
      warnings.push({ field: `items[${i}].description`, message: `Rule description "${description}" is listed more than once; the last one wins.`, code: 'DUPLICATE_DESCRIPTION' })
    } else {
      seen.add(description)
    }

    if (!detectionCategory) {
      errors.push({ field: `items[${i}].detection_category`, message: 'Detection category is required.', code: 'EMPTY_CATEGORY' })
    } else if (!DETECTION_CATEGORIES.has(detectionCategory)) {
      errors.push({ field: `items[${i}].detection_category`, message: `Detection category "${detectionCategory}" is not one of ${[...DETECTION_CATEGORIES].join(', ')}.`, code: 'INVALID_CATEGORY' })
    }

    if (!detection) {
      errors.push({ field: `items[${i}].detection`, message: 'Detection type is required.', code: 'EMPTY_DETECTION' })
    }

    if (!isWhitelist && !triageCategory) {
      errors.push({ field: `items[${i}].triage_category`, message: 'A non-whitelist rule must set a triage category.', code: 'MISSING_TRIAGE_CATEGORY' })
    }
    if (isWhitelist && triageCategory) {
      warnings.push({ field: `items[${i}].triage_category`, message: 'Triage category is ignored for a whitelist rule.', code: 'TRIAGE_CATEGORY_IGNORED' })
    }

    const hosts = parseList(f.host)
    const ips = parseList(f.ip)
    if (!allHosts && hosts.length === 0 && ips.length === 0) {
      errors.push({ field: `items[${i}].all_hosts`, message: 'Scope the rule: either apply to all hosts, or name at least one host ID or source IP.', code: 'MISSING_SCOPE' })
    }

    hosts.forEach((h) => {
      if (!Number.isFinite(Number(h))) {
        warnings.push({ field: `items[${i}].host`, message: `Host ID "${h}" is not numeric and will be dropped.`, code: 'NON_NUMERIC_HOST' })
      }
    })

    ;[...ips, ...parseList(f.remote1_ip)].forEach((addr) => {
      if (!isIpOrCidr(addr)) {
        errors.push({ field: `items[${i}].ip`, message: `"${addr}" is not a valid IPv4 address or CIDR range.`, code: 'INVALID_IP' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
