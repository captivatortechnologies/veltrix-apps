import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { classifyAcl, readAclFields, ACL_RULE_IDS, URL_PATTERNS } from './_shared'

/**
 * Validate ACL configuration items. Static (no target access): a numeric Site ID,
 * a known ACL type, and the values that ACL type needs:
 *   - IP blacklist / whitelist → a list of IPs (empty clears the list → warned);
 *   - country blacklist → countries and/or continents (both empty clears → warned);
 *   - URL blacklist → equal-length urls + url_patterns, patterns from the enum.
 * Each ACL type is a singleton per site, so a duplicate (siteId, aclId) is flagged.
 */
const SITE_ID_RE = /^[0-9]+$/
const CODE_RE = /^[A-Za-z]{2}$/
const IP_CHARS_RE = /^[0-9a-fA-F:.\-/]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one ACL.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = readAclFields(item.fields)

    if (!f.siteId) {
      errors.push({ field: `items[${i}].siteId`, message: 'Site ID is required.', code: 'EMPTY_SITE_ID' })
    } else if (!SITE_ID_RE.test(f.siteId)) {
      errors.push({ field: `items[${i}].siteId`, message: `Site ID "${f.siteId}" must be numeric.`, code: 'INVALID_SITE_ID' })
    }

    const kind = classifyAcl(f.aclId)
    if (!f.aclId) {
      errors.push({ field: `items[${i}].aclId`, message: 'An ACL type is required.', code: 'EMPTY_ACL_ID' })
    } else if (!ACL_RULE_IDS.has(f.aclId) || !kind) {
      errors.push({
        field: `items[${i}].aclId`,
        message: `ACL type "${f.aclId}" is not supported. Use one of: ${[...ACL_RULE_IDS].join(', ')}.`,
        code: 'INVALID_ACL_ID',
      })
    } else if (f.siteId) {
      const key = `${f.siteId}::${f.aclId}`
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].aclId`, message: `ACL "${f.aclId}" is configured more than once for site ${f.siteId}; the last one wins.`, code: 'DUPLICATE_ACL' })
      } else {
        seen.add(key)
      }
    }

    if (kind === 'ips') {
      if (f.ips.length === 0) {
        warnings.push({ field: `items[${i}].ips`, message: 'No IPs listed — deploying this will clear the ACL list for the site.', code: 'EMPTY_IPS' })
      } else {
        for (const ip of f.ips) {
          if (!IP_CHARS_RE.test(ip)) {
            warnings.push({ field: `items[${i}].ips`, message: `"${ip}" does not look like an IP, range or CIDR.`, code: 'SUSPICIOUS_IP' })
          }
        }
      }
    } else if (kind === 'geo') {
      if (f.countries.length === 0 && f.continents.length === 0) {
        warnings.push({ field: `items[${i}].countries`, message: 'No countries or continents listed — nothing will be blacklisted for the site.', code: 'EMPTY_GEO' })
      }
      for (const c of f.countries) {
        if (!CODE_RE.test(c)) warnings.push({ field: `items[${i}].countries`, message: `Country code "${c}" should be a two-letter ISO code.`, code: 'SUSPICIOUS_COUNTRY' })
      }
      for (const c of f.continents) {
        if (!CODE_RE.test(c)) warnings.push({ field: `items[${i}].continents`, message: `Continent code "${c}" should be a two-letter code.`, code: 'SUSPICIOUS_CONTINENT' })
      }
    } else if (kind === 'urls') {
      if (f.urls.length === 0) {
        errors.push({ field: `items[${i}].urls`, message: 'At least one URL is required for a URL blacklist.', code: 'EMPTY_URLS' })
      }
      if (f.urlPatterns.length === 0) {
        errors.push({ field: `items[${i}].urlPatterns`, message: 'A match pattern is required for each URL.', code: 'EMPTY_URL_PATTERNS' })
      }
      if (f.urls.length > 0 && f.urlPatterns.length > 0 && f.urls.length !== f.urlPatterns.length) {
        errors.push({
          field: `items[${i}].urlPatterns`,
          message: `URLs (${f.urls.length}) and patterns (${f.urlPatterns.length}) must be the same length — each URL is paired positionally with a pattern.`,
          code: 'URL_PATTERN_MISMATCH',
        })
      }
      for (const p of f.urlPatterns) {
        if (!URL_PATTERNS.has(p)) {
          errors.push({ field: `items[${i}].urlPatterns`, message: `Pattern "${p}" is not supported. Use one of: ${[...URL_PATTERNS].join(', ')}.`, code: 'INVALID_URL_PATTERN' })
        }
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
