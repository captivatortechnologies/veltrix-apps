import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { slugify } from '../../lib/sentinel'

/** AlertSeverity enum (api-version 2024-09-01) — the severitiesFilter values. */
export const SEVERITIES = ['High', 'Medium', 'Low', 'Informational'] as const
/**
 * MicrosoftSecurityProductName enum (api-version 2024-09-01) — the source product
 * whose alerts create Sentinel incidents. Legacy service names; the canvas maps
 * them to current product labels. "Microsoft Defender Advanced Threat Protection"
 * is NOT a member of the service enum, so it is intentionally absent.
 */
export const PRODUCT_FILTERS = [
  'Microsoft Cloud App Security',
  'Azure Security Center',
  'Azure Advanced Threat Protection',
  'Azure Active Directory Identity Protection',
  'Azure Security Center for IoT',
] as const

export type Severity = (typeof SEVERITIES)[number]
export type ProductFilter = (typeof PRODUCT_FILTERS)[number]

/** One MicrosoftSecurityIncidentCreation rule authored on the canvas. */
export interface MsSecurityRuleSpec {
  sectionName: string
  ruleName: string
  /** Namespaced, URL-safe ARM ruleId derived from the name (deterministic →
   *  idempotent PUT; prefixed so it can't collide with an analytics-rule slug). */
  ruleId: string
  enabled: boolean
  productFilter: string
  description: string
  /** Optional alert-displayName include/exclude and severity filters (empty = match all). */
  displayNamesFilter: string[]
  displayNamesExcludeFilter: string[]
  severitiesFilter: string[]
}

/**
 * ARM ruleId namespace for this type. Both this type and the shipped
 * sentinel-analytics-rules type write into the SAME `/alertRules` collection keyed
 * by slug-of-name, so identical names would collide (the second PUT overwrites the
 * first and flips its `kind`). slugify collapses runs to a single hyphen and never
 * emits a leading/trailing or double hyphen, so a prefix that ENDS in `--` can
 * never equal any analytics rule's slug — making the namespaces provably disjoint.
 */
export const MS_SECURITY_RULE_ID_PREFIX = 'mssecurity--'

/** The intra-type uniqueness key is the slug of the rule name. */
export function ruleKey(name: string): string {
  return slugify(name)
}

/** The ARM ruleId — namespaced so it cannot collide with an analytics rule. */
export function msSecurityRuleId(name: string): string {
  return MS_SECURITY_RULE_ID_PREFIX + slugify(name)
}

function readBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
}

/** Read a tags/list field into a trimmed string array (accepts a comma string too). */
export function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Each canvas item is one MicrosoftSecurityIncidentCreation rule. */
export function extractMsSecuritySpecs(canvas: CanvasSnapshot): MsSecurityRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.rule_name === 'string' ? fields.rule_name.trim() : ''
    return {
      sectionName: section.name,
      ruleName: name,
      ruleId: msSecurityRuleId(name),
      enabled: readBool(fields.enabled, true),
      productFilter: typeof fields.product_filter === 'string' ? fields.product_filter.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      displayNamesFilter: readList(fields.display_names_filter),
      displayNamesExcludeFilter: readList(fields.display_names_exclude_filter),
      severitiesFilter: readList(fields.severities_filter),
    }
  })
}

/**
 * Validate Microsoft Security (MicrosoftSecurityIncidentCreation) rules. Each needs
 * a unique name and a valid source productFilter; any severitiesFilter entries must
 * be AlertSeverity values. The displayName include/exclude filters are free text.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no Microsoft Security rules', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const spec of extractMsSecuritySpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required', code: 'required' })
    } else {
      const key = ruleKey(spec.ruleName)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.rule_name`,
          message: `Duplicate rule name "${spec.ruleName}" (names must be unique after slugging to "${key}")`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }

    if (!spec.productFilter) {
      errors.push({ field: `${prefix}.product_filter`, message: 'Product filter is required', code: 'required' })
    } else if (!PRODUCT_FILTERS.includes(spec.productFilter as ProductFilter)) {
      errors.push({
        field: `${prefix}.product_filter`,
        message: `Product filter must be one of ${PRODUCT_FILTERS.join(', ')}`,
        code: 'invalid_product',
      })
    }

    for (const severity of spec.severitiesFilter) {
      if (!SEVERITIES.includes(severity as Severity)) {
        errors.push({
          field: `${prefix}.severities_filter`,
          message: `Invalid severity "${severity}" — must be one of ${SEVERITIES.join(', ')}`,
          code: 'invalid_severity',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
