import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parsePolicyJson, policyFamily, isEndpointSecurityFamily } from '../../lib/policy'

export interface PolicyImportSpec {
  sectionName: string
  name: string
  description: string
  policyJsonRaw: string
}

/** The policy name is the reconciliation key. */
export function policyKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item is one imported endpoint-security policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicyImportSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.policy_name === 'string' ? fields.policy_name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      policyJsonRaw: typeof fields.policy_json === 'string' ? fields.policy_json : '',
    }
  })
}

/**
 * Validate imported endpoint-security policies: each needs a name (unique across
 * the canvas) and a pasted policy JSON that parses to a settings-catalog policy
 * (a `settings` array + a `templateReference`). Warn if the template family is
 * not one of the endpoint-security families this app is intended for.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no policy items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.policy_name`, message: 'Policy name is required', code: 'required' })
    } else {
      const key = policyKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.policy_name`, message: `Duplicate policy name "${spec.name}"`, code: 'duplicate_policy' })
      }
      seen.add(key)
    }

    const parsed = parsePolicyJson(spec.policyJsonRaw)
    if (parsed.error) {
      errors.push({ field: `${prefix}.policy_json`, message: `Policy JSON ${parsed.error}`, code: 'invalid_json' })
    } else if (parsed.value) {
      const family = policyFamily(parsed.value)
      if (family && !isEndpointSecurityFamily(family)) {
        warnings.push({
          field: `${prefix}.policy_json`,
          message: `Template family "${family}" is not a Defender endpoint-security family — deploy it only if you intend to manage a non-endpoint-security settings-catalog policy`,
          code: 'non_endpoint_security_family',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
