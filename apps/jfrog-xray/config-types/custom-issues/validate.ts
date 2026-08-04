import type { PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonArray } from '../../lib/fields'
import { extractCustomIssueSpecs, SEVERITIES, type CustomIssueSpec } from './_shared'

/**
 * Validate JFrog Xray custom-issue items. Static — no target access required.
 *   - `id` is required, must not start with "xray" (case-insensitive — reserved
 *     for Xray's own issues), and is the upsert identity (duplicates rejected).
 *   - `provider` is required and must not be "jfrog" (case-insensitive — reserved).
 *   - `package_type`, `type`, `severity`, `summary`, `description` are required.
 *     `severity` is validated against the documented values; `type` and
 *     `package_type` are NOT — Xray's OpenAPI schema does not enforce an enum
 *     for either, so a value outside our suggested list is allowed through.
 *   - `components_json` is required and must be a non-empty JSON array of
 *     objects each carrying a non-blank `id`.
 *   - `cves_json` / `sources_json`, when set, must be JSON arrays.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractCustomIssueSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom issue.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    validateIdentity(spec, prefix, errors, seen)
    validateRequiredFields(spec, prefix, errors)
    validateComponents(spec, prefix, errors)
    validateOptionalJson(spec, prefix, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateIdentity(spec: CustomIssueSpec, prefix: string, errors: ValidationError[], seen: Set<string>): void {
  if (!spec.id) {
    errors.push({ field: `${prefix}.id`, message: 'Issue ID is required.', code: 'EMPTY_ID' })
    return
  }
  if (/^xray/i.test(spec.id)) {
    errors.push({ field: `${prefix}.id`, message: `Issue ID "${spec.id}" must not start with "Xray" — that prefix is reserved.`, code: 'RESERVED_ID_PREFIX' })
  }
  if (/[/\\]/.test(spec.id)) {
    errors.push({ field: `${prefix}.id`, message: `Issue ID "${spec.id}" must not contain "/" or "\\" — it is used directly in the API URL.`, code: 'INVALID_ID' })
  }
  const key = spec.id.trim()
  if (seen.has(key)) {
    errors.push({ field: `${prefix}.id`, message: `Duplicate issue ID "${spec.id}" — each id may only be declared once.`, code: 'DUPLICATE_ID' })
  }
  seen.add(key)

  if (!spec.provider) {
    errors.push({ field: `${prefix}.provider`, message: 'Provider is required.', code: 'EMPTY_PROVIDER' })
  } else if (spec.provider.toLowerCase() === 'jfrog') {
    errors.push({ field: `${prefix}.provider`, message: 'Provider must not be "JFrog" — that value is reserved.', code: 'RESERVED_PROVIDER' })
  }
}

function validateRequiredFields(spec: CustomIssueSpec, prefix: string, errors: ValidationError[]): void {
  if (!spec.packageType) errors.push({ field: `${prefix}.package_type`, message: 'Package Type is required.', code: 'EMPTY_PACKAGE_TYPE' })
  if (!spec.type) errors.push({ field: `${prefix}.type`, message: 'Type is required.', code: 'EMPTY_TYPE' })
  if (!SEVERITIES.includes(spec.severity as (typeof SEVERITIES)[number])) {
    errors.push({ field: `${prefix}.severity`, message: `Severity "${spec.severity}" must be one of ${SEVERITIES.join(', ')}.`, code: 'INVALID_SEVERITY' })
  }
  if (!spec.summary) errors.push({ field: `${prefix}.summary`, message: 'Summary is required.', code: 'EMPTY_SUMMARY' })
  if (!spec.description) errors.push({ field: `${prefix}.description`, message: 'Description is required.', code: 'EMPTY_DESCRIPTION' })
}

function validateComponents(spec: CustomIssueSpec, prefix: string, errors: ValidationError[]): void {
  const parsed = parseJsonArray(spec.componentsJson)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.components_json`, message: `Components ${parsed.error}.`, code: 'INVALID_JSON' })
    return
  }
  if (parsed.value.length === 0) {
    errors.push({ field: `${prefix}.components_json`, message: 'At least one affected component is required.', code: 'EMPTY_COMPONENTS' })
    return
  }
  parsed.value.forEach((entry, ci) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ field: `${prefix}.components_json[${ci}]`, message: 'Each component must be a JSON object.', code: 'INVALID_COMPONENT' })
      return
    }
    const rec = entry as Record<string, unknown>
    if (typeof rec.id !== 'string' || !rec.id.trim()) {
      errors.push({ field: `${prefix}.components_json[${ci}].id`, message: 'Each component needs an "id".', code: 'INVALID_COMPONENT' })
    }
  })
}

function validateOptionalJson(spec: CustomIssueSpec, prefix: string, errors: ValidationError[]): void {
  const cves = parseJsonArray(spec.cvesJson)
  if (!cves.ok) {
    errors.push({ field: `${prefix}.cves_json`, message: `CVEs ${cves.error}.`, code: 'INVALID_JSON' })
  }
  const sources = parseJsonArray(spec.sourcesJson)
  if (!sources.ok) {
    errors.push({ field: `${prefix}.sources_json`, message: `Sources ${sources.error}.`, code: 'INVALID_JSON' })
  }
}
