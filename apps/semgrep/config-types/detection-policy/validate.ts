import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, validationErrorsFromResponse } from '../../lib/semgrepApi'
import { DETECTION_POLICY_PRODUCTS, bundleFromSpec, extractDetectionPolicySpecs, isDetectionPolicyProduct } from './_shared'

/** At most one live dry-run per product — there are only ever two products. */
const MAX_LIVE_DRYRUN_CHECKS = DETECTION_POLICY_PRODUCTS.length

/**
 * Validate Detection Policy items: a valid, unique product per canvas (at most
 * one "code" and one "secrets" item); Secrets bundles must have an empty
 * ruleset list (the API rejects otherwise); exceptions must be a well-formed
 * JSON array with exactly one of project / project_tag_name per entry.
 *
 * Live pre-flight (best-effort): when a connection is available, each valid
 * bundle is dry-run against Semgrep's own Policies V2 validator
 * (POST .../detection-policy/{product}:dryRun) and any validation_errors it
 * reports are surfaced here — a stronger guarantee than the static checks
 * alone. Skipped entirely without a connection; a transient failure (network,
 * 401/403/5xx, id resolution) never blocks validate — only a definitive
 * validation_errors response from a successful dry run does.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractDetectionPolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one detection policy (Code or Secrets).', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.product) {
      errors.push({ field: `${prefix}.product`, message: 'Product is required.', code: 'EMPTY_PRODUCT' })
      return
    }
    if (!isDetectionPolicyProduct(spec.product)) {
      errors.push({
        field: `${prefix}.product`,
        message: `Product must be one of: ${DETECTION_POLICY_PRODUCTS.join(', ')}.`,
        code: 'INVALID_PRODUCT',
      })
      return
    }
    if (seen.has(spec.product)) {
      errors.push({
        field: `${prefix}.product`,
        message: `Product "${spec.product}" is declared more than once — each product may only appear once.`,
        code: 'DUPLICATE_PRODUCT',
      })
    }
    seen.add(spec.product)

    if (spec.product === 'secrets' && spec.rulesets.length > 0) {
      errors.push({
        field: `${prefix}.rulesets`,
        message: 'Secrets bundles must have an empty ruleset list — Semgrep Secrets rules are not registry rulesets.',
        code: 'SECRETS_RULESETS_NOT_ALLOWED',
      })
    }

    if (spec.exceptions === null) {
      errors.push({
        field: `${prefix}.exceptionsJson`,
        message:
          'Exceptions must be valid JSON — an array of {exception_type, project|project_tag_name, rule, rule_type} objects.',
        code: 'INVALID_EXCEPTIONS_JSON',
      })
    } else {
      spec.exceptions.forEach((exc, j) => {
        const excPrefix = `${prefix}.exceptionsJson[${j}]`
        if (exc.exception_type !== 'include' && exc.exception_type !== 'exclude') {
          errors.push({ field: excPrefix, message: 'exception_type must be "include" or "exclude".', code: 'INVALID_EXCEPTION_TYPE' })
        }
        if (!exc.rule || typeof exc.rule !== 'string') {
          errors.push({ field: excPrefix, message: 'rule is required.', code: 'EMPTY_EXCEPTION_RULE' })
        }
        if (exc.rule_type !== 'rule' && exc.rule_type !== 'pack') {
          errors.push({ field: excPrefix, message: 'rule_type must be "rule" or "pack".', code: 'INVALID_EXCEPTION_RULE_TYPE' })
        }
        const hasProject = typeof exc.project === 'string' && exc.project.trim().length > 0
        const hasTag = typeof exc.project_tag_name === 'string' && exc.project_tag_name.trim().length > 0
        if (hasProject === hasTag) {
          errors.push({ field: excPrefix, message: 'Exactly one of project or project_tag_name must be set.', code: 'EXCEPTION_SCOPE_AMBIGUOUS' })
        }
      })
    }
  })

  if (ctx.credential && ctx.component) {
    try {
      const built = buildSemgrepClient(ctx.credential, ctx.settings)
      if (!('error' in built) && built.client.hasSlug) {
        const { client } = built
        const resolved = await client.resolveDeploymentId()
        if (!('error' in resolved)) {
          let checks = 0
          for (const spec of specs) {
            if (checks >= MAX_LIVE_DRYRUN_CHECKS) break
            if (!isDetectionPolicyProduct(spec.product) || spec.exceptions === null) continue
            checks++
            const res = await client.dryRunDetectionPolicy(resolved.id, spec.product, bundleFromSpec(spec))
            if (res.ok) {
              for (const ve of validationErrorsFromResponse(res)) {
                errors.push({
                  field: `items.${spec.product}`,
                  message: ve.message || `Semgrep rejected the "${spec.product}" bundle (${ve.code ?? 'validation error'}).`,
                  code: ve.code ? `SEMGREP_${ve.code}` : 'SEMGREP_VALIDATION_ERROR',
                })
              }
            } else if (res.status === 404) {
              warnings.push({
                field: `items.${spec.product}`,
                message: `Product "${spec.product}" is not enabled for this deployment — the live dry-run preview could not run.`,
                code: 'PRODUCT_NOT_ENABLED',
              })
            }
            // Any other non-ok status (401/403/5xx) is treated as "unknown" and
            // never flagged — a token/permission/network blip can't produce a
            // false validation error.
          }
        }
      }
    } catch {
      // Best-effort: a network error during the live pre-flight never blocks validate.
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
