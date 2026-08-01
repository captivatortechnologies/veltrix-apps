import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  extractTriageSpecs,
  hasNarrowingFilter,
  ISSUE_TYPES,
  MAX_NOTE_LENGTH,
  SEVERITIES,
  TARGET_STATES,
  TRIAGE_REASONS,
} from './_shared'
import { normalizeName } from '../../lib/canvas'

/**
 * Validate triage rules. Static — no target access. Enforces the Semgrep API's
 * own rules plus a safety guardrail:
 *   - a unique, non-empty rule name (the canvas identity);
 *   - a valid finding type and target state;
 *   - `triageReason` is only valid when the target state is `ignored` (API rule);
 *   - a narrowing filter (repos / rules / severities) is REQUIRED so a rule can
 *     never bulk-triage an entire deployment.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractTriageSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one triage rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const label = spec.ruleName || `item ${i}`

    if (!spec.ruleName) {
      errors.push({ field: `items[${i}].ruleName`, message: 'Rule name is required.', code: 'EMPTY_RULE_NAME' })
    } else {
      const key = normalizeName(spec.ruleName)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].ruleName`,
          message: `Triage rule "${spec.ruleName}" is declared more than once — each rule name must be unique.`,
          code: 'DUPLICATE_RULE',
        })
      } else {
        seen.add(key)
      }
    }

    if (!(ISSUE_TYPES as readonly string[]).includes(spec.issueType)) {
      errors.push({
        field: `items[${i}].issueType`,
        message: `Finding type for "${label}" must be one of: ${ISSUE_TYPES.join(', ')}.`,
        code: 'INVALID_ISSUE_TYPE',
      })
    }

    if (!(TARGET_STATES as readonly string[]).includes(spec.targetState)) {
      errors.push({
        field: `items[${i}].targetState`,
        message: `New triage state for "${label}" must be one of: ${TARGET_STATES.join(', ')}.`,
        code: 'INVALID_TARGET_STATE',
      })
    }

    if (spec.triageReason) {
      if (!(TRIAGE_REASONS as readonly string[]).includes(spec.triageReason)) {
        errors.push({
          field: `items[${i}].triageReason`,
          message: `Ignore reason for "${label}" must be one of: ${TRIAGE_REASONS.join(', ')}.`,
          code: 'INVALID_TRIAGE_REASON',
        })
      } else if (spec.targetState !== 'ignored') {
        errors.push({
          field: `items[${i}].triageReason`,
          message: `Ignore reason for "${label}" is only valid when the new state is "ignored" (Semgrep API rule).`,
          code: 'REASON_REQUIRES_IGNORED',
        })
      }
    }

    for (const sev of spec.severities) {
      if (!(SEVERITIES as readonly string[]).includes(sev)) {
        errors.push({
          field: `items[${i}].severities`,
          message: `Severity "${sev}" for "${label}" must be one of: ${SEVERITIES.join(', ')}.`,
          code: 'INVALID_SEVERITY',
        })
      }
    }

    if (!hasNarrowingFilter(spec)) {
      errors.push({
        field: `items[${i}]`,
        message: `Triage rule "${label}" must set at least one narrowing filter (repositories, rules, or severities) — a rule may not triage an entire deployment.`,
        code: 'SELECTION_TOO_BROAD',
      })
    }

    if (spec.note.length > MAX_NOTE_LENGTH) {
      errors.push({
        field: `items[${i}].note`,
        message: `Note for "${label}" exceeds the ${MAX_NOTE_LENGTH}-character Semgrep limit.`,
        code: 'NOTE_TOO_LONG',
      })
    }

    if (spec.rules.length > 0 && spec.issueType !== 'sast') {
      warnings.push({
        field: `items[${i}].rules`,
        message: `Rule-name filters for "${label}" apply to Code (SAST) findings — they are ignored for ${spec.issueType} findings.`,
        code: 'RULES_FILTER_IGNORED',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
