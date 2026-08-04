import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { EXCEPTION_PARAM_MAPPING, EXCEPTION_RULE_IDS, exceptionSignature, readExceptionFields } from './_shared'

/**
 * Validate security rule exception items: a numeric Site ID, a known rule id,
 * and at least one match-condition value from among the params that rule id's
 * exceptions support. Static — no target access required. Two items for the
 * same site declaring the exact same condition are flagged as duplicates
 * (an exception is identified by its content — see ./_shared exceptionSignature).
 */
const SITE_ID_RE = /^[0-9]+$/

const PARAM_FIELD_LABEL: Record<string, string> = {
  client_app_types: 'clientAppTypes',
  client_apps: 'clientApps',
  countries: 'countries',
  continents: 'continents',
  ips: 'ips',
  urls: 'urls',
  user_agents: 'userAgents',
  parameters: 'parameters',
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one security rule exception.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = readExceptionFields(item.fields)
    const p = (field: string) => `items[${i}].${field}`

    if (!f.siteId) {
      errors.push({ field: p('siteId'), message: 'Site ID is required.', code: 'EMPTY_SITE_ID' })
    } else if (!SITE_ID_RE.test(f.siteId)) {
      errors.push({ field: p('siteId'), message: `Site ID "${f.siteId}" must be numeric.`, code: 'INVALID_SITE_ID' })
    }

    const allowedParams = EXCEPTION_PARAM_MAPPING[f.ruleId]
    if (!f.ruleId) {
      errors.push({ field: p('ruleId'), message: 'A rule is required.', code: 'EMPTY_RULE_ID' })
    } else if (!allowedParams) {
      errors.push({ field: p('ruleId'), message: `Rule "${f.ruleId}" is not supported. Use one of: ${[...EXCEPTION_RULE_IDS].join(', ')}.`, code: 'INVALID_RULE_ID' })
    } else {
      const hasAnyValue = allowedParams.some((param) => (f[PARAM_FIELD_LABEL[param] as keyof typeof f] as string[]).length > 0)
      if (!hasAnyValue) {
        errors.push({ field: p('ruleId'), message: `At least one match condition is required. Rule "${f.ruleId}" accepts: ${allowedParams.join(', ')}.`, code: 'EMPTY_CONDITIONS' })
      }
      // Flag any declared field the chosen rule id does not accept (silently ignored on deploy otherwise).
      for (const [param, fieldKey] of Object.entries(PARAM_FIELD_LABEL)) {
        if (allowedParams.includes(param)) continue
        if ((f[fieldKey as keyof typeof f] as string[]).length > 0) {
          warnings.push({ field: p(fieldKey), message: `Rule "${f.ruleId}" does not accept "${param}" — this value will be ignored on deploy.`, code: 'UNSUPPORTED_CONDITION' })
        }
      }

      if (f.siteId) {
        const key = `${f.siteId}::${exceptionSignature(f)}`
        if (seen.has(key)) {
          warnings.push({ field: p('ruleId'), message: `An identical exception is already declared for site ${f.siteId} and rule ${f.ruleId} — duplicates collapse into one.`, code: 'DUPLICATE_EXCEPTION' })
        } else {
          seen.add(key)
        }
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
