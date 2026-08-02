import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractRuleSetSpecs, providerConsumerShapeError, MAX_NAME_LENGTH } from './_shared'

/**
 * Static structural validation only — no live PCE access here (that's what
 * deploy's fail-closed href resolution is for). Checks the ruleset shape, the
 * scope-label shape, and every rule's shape (exactly one actor kind per
 * provider/consumer, at least one service — required once resolve_labels_as
 * resolves providers as workloads, per the Terraform provider's
 * ingress_services description).
 */
export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRuleSetSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate ruleset "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.scopeLabelsError) {
      errors.push({ field: `${prefix}.scopeLabelsJson`, message: `Scope labels ${spec.scopeLabelsError}`, code: 'invalid_json' })
    } else if (spec.scopeLabels.length === 0) {
      errors.push({
        field: `${prefix}.scopeLabelsJson`,
        message: 'A ruleset needs at least one scope label (the PCE requires at least one scope)',
        code: 'empty_scope',
      })
    } else {
      spec.scopeLabels.forEach((l, li) => {
        if (!l.key || !l.value) {
          errors.push({ field: `${prefix}.scopeLabelsJson[${li}]`, message: 'Each scope label needs both key and value', code: 'invalid_scope_label' })
        }
      })
    }

    if (spec.rulesError) {
      errors.push({ field: `${prefix}.rulesJson`, message: `Rules ${spec.rulesError}`, code: 'invalid_json' })
      return
    }
    if (spec.rules.length === 0) {
      errors.push({ field: `${prefix}.rulesJson`, message: 'A ruleset needs at least one rule', code: 'empty_rules' })
    }

    spec.rules.forEach((rule, ri) => {
      const rPrefix = `${prefix}.rulesJson[${ri}]`
      if (rule.providers.length === 0) {
        errors.push({ field: `${rPrefix}.providers`, message: 'A rule needs at least one provider', code: 'empty_providers' })
      }
      if (rule.consumers.length === 0) {
        errors.push({ field: `${rPrefix}.consumers`, message: 'A rule needs at least one consumer', code: 'empty_consumers' })
      }
      if (rule.services.length === 0) {
        errors.push({
          field: `${rPrefix}.services`,
          message: 'A rule needs at least one service (required when providers resolve as workloads)',
          code: 'empty_services',
        })
      }
      rule.providers.forEach((p, pi) => {
        const err = providerConsumerShapeError(p, 'a provider')
        if (err) errors.push({ field: `${rPrefix}.providers[${pi}]`, message: err, code: 'invalid_actor' })
      })
      rule.consumers.forEach((c, ci) => {
        const err = providerConsumerShapeError(c, 'a consumer')
        if (err) errors.push({ field: `${rPrefix}.consumers[${ci}]`, message: err, code: 'invalid_actor' })
      })
      rule.services.forEach((s, si) => {
        if (!s.name) errors.push({ field: `${rPrefix}.services[${si}].name`, message: 'Service name is required', code: 'required' })
      })
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
