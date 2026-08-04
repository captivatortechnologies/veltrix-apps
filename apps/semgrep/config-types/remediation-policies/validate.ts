import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, validationErrorsFromResponse } from '../../lib/semgrepApi'
import { bundleFromSpecs, extractRemediationPolicySpecs, isCompleteSpec } from './_shared'
import { normalizeName } from '../../lib/canvas'

const VALID_FILTER_MODES = new Set(['all', 'any'])
const VALID_CONDITION_MODES = new Set(['any', 'none'])

/**
 * Validate Remediation Policy items: a required, unique slug + name per canvas;
 * a valid filters.mode; a well-formed, non-empty conditions array (each with a
 * type + non-empty values); a well-formed, non-empty actions array (each with a
 * type). The item LIST is the whole declared bundle — an empty canvas is
 * rejected outright (never silently deployed as "delete every policy").
 *
 * Live pre-flight (best-effort): when a connection is available and every spec
 * parsed cleanly, the WHOLE candidate bundle is dry-run against Semgrep's own
 * Policies V2 validator (POST .../remediation-policies:dryRun) — this is where
 * companion-action requirements (e.g. "block" requires "pr_comment" in the same
 * policy) and accepted condition/action types are actually enforced, rather
 * than duplicated here. Skipped entirely without a connection; a transient
 * failure never blocks validate — only a definitive validation_errors response
 * from a successful dry run does.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractRemediationPolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one remediation policy.', code: 'EMPTY' })
  }

  const seenSlugs = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.slug) {
      errors.push({
        field: `${prefix}.slug`,
        message: "Slug is required — Semgrep treats it as the policy's immutable identity.",
        code: 'EMPTY_SLUG',
      })
    } else {
      const key = normalizeName(spec.slug)
      if (seenSlugs.has(key)) {
        errors.push({
          field: `${prefix}.slug`,
          message: `Slug "${spec.slug}" is declared more than once — each policy must have a unique slug.`,
          code: 'DUPLICATE_SLUG',
        })
      }
      seenSlugs.add(key)
    }

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    }

    if (!VALID_FILTER_MODES.has(spec.filterMode)) {
      errors.push({ field: `${prefix}.filterMode`, message: 'Filter mode must be "all" or "any".', code: 'INVALID_FILTER_MODE' })
    }

    if (spec.conditions === null) {
      errors.push({
        field: `${prefix}.conditionsJson`,
        message: 'Conditions must be valid JSON — an array of {type, values, mode?} objects.',
        code: 'INVALID_CONDITIONS_JSON',
      })
    } else if (spec.conditions.length === 0) {
      errors.push({ field: `${prefix}.conditionsJson`, message: 'At least one condition is required.', code: 'EMPTY_CONDITIONS' })
    } else {
      spec.conditions.forEach((cond, j) => {
        const condPrefix = `${prefix}.conditionsJson[${j}]`
        if (!cond.type || typeof cond.type !== 'string') {
          errors.push({ field: condPrefix, message: 'type is required.', code: 'EMPTY_CONDITION_TYPE' })
        }
        if (!Array.isArray(cond.values) || cond.values.length === 0) {
          errors.push({ field: condPrefix, message: 'values must be a non-empty array.', code: 'EMPTY_CONDITION_VALUES' })
        }
        if (cond.mode !== undefined && !VALID_CONDITION_MODES.has(cond.mode)) {
          errors.push({ field: condPrefix, message: 'mode must be "any" or "none".', code: 'INVALID_CONDITION_MODE' })
        }
      })
    }

    if (spec.actions === null) {
      errors.push({
        field: `${prefix}.actionsJson`,
        message: 'Actions must be valid JSON — an array of {type, config?} objects.',
        code: 'INVALID_ACTIONS_JSON',
      })
    } else if (spec.actions.length === 0) {
      errors.push({ field: `${prefix}.actionsJson`, message: 'At least one action is required.', code: 'EMPTY_ACTIONS' })
    } else {
      spec.actions.forEach((act, j) => {
        const actPrefix = `${prefix}.actionsJson[${j}]`
        if (!act.type || typeof act.type !== 'string') {
          errors.push({ field: actPrefix, message: 'type is required.', code: 'EMPTY_ACTION_TYPE' })
        }
      })
    }
  })

  if (ctx.credential && ctx.component && specs.length > 0 && specs.every(isCompleteSpec)) {
    try {
      const built = buildSemgrepClient(ctx.credential, ctx.settings)
      if (!('error' in built) && built.client.hasSlug) {
        const { client } = built
        const resolved = await client.resolveDeploymentId()
        if (!('error' in resolved)) {
          const res = await client.dryRunRemediationPolicies(resolved.id, bundleFromSpecs(specs))
          if (res.ok) {
            for (const ve of validationErrorsFromResponse(res)) {
              const scopedField = ve.policy_slug ? `items.${ve.policy_slug}` : 'items'
              errors.push({
                field: scopedField,
                message: ve.message || `Semgrep rejected the bundle (${ve.code ?? 'validation error'}).`,
                code: ve.code ? `SEMGREP_${ve.code}` : 'SEMGREP_VALIDATION_ERROR',
              })
            }
          }
          // Any other non-ok status (401/403/5xx) is treated as "unknown" and
          // never flagged — a token/permission/network blip can't produce a
          // false validation error.
        }
      }
    } catch {
      // Best-effort: a network error during the live pre-flight never blocks validate.
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
