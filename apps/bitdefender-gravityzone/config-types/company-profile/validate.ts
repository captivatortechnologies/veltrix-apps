import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { companyProfileKey, extractCompanyProfileSpecs, parseContactPerson, parseMdrContactInformation } from './_shared'

/**
 * Validate company profile declaration(s): unique companyId (including
 * multiple blank declarations, which all mean "the API key's own company"),
 * and parseable JSON for the two contact objects. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one company profile declaration.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCompanyProfileSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    const key = companyProfileKey(spec.companyId)
    if (seen.has(key)) {
      warnings.push({
        field: `${prefix}.companyId`,
        message: spec.companyId
          ? `Company "${spec.companyId}" is declared more than once; the last one wins.`
          : "More than one declaration leaves Company ID blank (the API key's own company); the last one wins.",
        code: 'DUPLICATE_COMPANY',
      })
    } else {
      seen.add(key)
    }

    if (spec.contactPersonRaw) {
      const { error } = parseContactPerson(spec)
      if (error) errors.push({ field: `${prefix}.contactPerson`, message: error, code: 'INVALID_JSON' })
    }

    if (spec.mdrContactInformationRaw) {
      const { error } = parseMdrContactInformation(spec)
      if (error) errors.push({ field: `${prefix}.mdrContactInformation`, message: error, code: 'INVALID_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
