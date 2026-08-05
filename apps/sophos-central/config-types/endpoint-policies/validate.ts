import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SOPHOS_POLICY_TYPES } from '../../lib/sophosApi'
import { extractPolicySpecs, parsePolicySpec, policyKey } from './_shared'

const NAME_RE = /^\S(?:.*\S)?$/
const DISABLE_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/
const KNOWN_APPLIES_TO_KEYS = new Set(['endpoints', 'users', 'userGroups'])

/**
 * Validate endpoint policy/ies: a required `name` (no leading/trailing
 * whitespace), a known `type`, a well-formed `disableAt` timestamp, and
 * `appliesTo`/`settings` values that parse to JSON objects. Only the
 * documented `appliesTo` keys are recognized (unknown keys warn rather than
 * error — Sophos's own schema may grow). Uniqueness is checked per
 * (name, type). Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one endpoint policy.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name || !NAME_RE.test(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required.', code: 'REQUIRED' })
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Policy type is required.', code: 'REQUIRED' })
    } else if (!(SOPHOS_POLICY_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `"${spec.type}" must be one of ${SOPHOS_POLICY_TYPES.join(', ')}.`,
        code: 'INVALID_TYPE',
      })
    }

    if (spec.name && spec.type) {
      const key = policyKey(spec.name, spec.type)
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.name`,
          message: `Policy "${spec.name}" (type "${spec.type}") is listed more than once; the last one wins.`,
          code: 'DUPLICATE_POLICY',
        })
      } else {
        seen.add(key)
      }
    }

    if (spec.disableAt && !DISABLE_AT_RE.test(spec.disableAt)) {
      errors.push({
        field: `${prefix}.disableAt`,
        message: `"${spec.disableAt}" must be an ISO-8601 UTC timestamp, e.g. 2026-12-31T00:00:00Z.`,
        code: 'INVALID_DISABLE_AT',
      })
    }

    const { value: parsed, error } = parsePolicySpec(spec)
    if (error) {
      errors.push({ field: `${prefix}.appliesTo`, message: error, code: 'INVALID_JSON' })
      return
    }
    if (!parsed) return

    for (const key of Object.keys(parsed.appliesTo)) {
      if (!KNOWN_APPLIES_TO_KEYS.has(key)) {
        warnings.push({
          field: `${prefix}.appliesTo`,
          message: `"${key}" is not one of the documented appliesTo keys (${[...KNOWN_APPLIES_TO_KEYS].join(', ')}) — passed through as declared.`,
          code: 'UNKNOWN_APPLIES_TO_KEY',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
