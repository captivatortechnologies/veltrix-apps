import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloud Security IOM custom-rule API constraints --------------------------
//
// A custom cloud configuration (IOM) rule evaluates a cloud resource against a
// Rego policy. Its identity in the tenant is `name`. Verified against the
// Terraform resource crowdstrike_cloud_security_iom_custom_rule and the
// FalconPy cloud-policies rules API. `alert_info`/`remediation_info` are
// auto-numbered by the console and `attack_types` are inherited from a parent
// rule, so none of the three is authored here.

export const CLOUD_PROVIDERS = ['aws', 'azure', 'gcp'] as const
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number]

export const IOM_SEVERITIES = ['critical', 'high', 'medium', 'informational'] as const
export type IomSeverity = (typeof IOM_SEVERITIES)[number]

export const MAX_NAME_LENGTH = 255

/** A single compliance-framework pairing (authority + rule code). */
export interface RuleControl {
  authority: string
  code: string
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface CloudIomRuleSpec {
  sectionName: string
  name: string
  description: string
  cloudProvider: string
  resourceType: string
  severity: string
  logic: string
  /** Raw controls field (JSON array); parsed on demand via parseControls. */
  controlsRaw: string
  parentRuleId?: string
}

/** Each canvas section describes one IOM custom rule. */
export function extractCloudIomRuleSpecs(canvas: CanvasSnapshot): CloudIomRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      cloudProvider:
        typeof fields.cloudProvider === 'string' ? fields.cloudProvider.trim().toLowerCase() : '',
      resourceType: typeof fields.resourceType === 'string' ? fields.resourceType.trim() : '',
      severity:
        typeof fields.severity === 'string' && fields.severity.trim()
          ? fields.severity.trim().toLowerCase()
          : 'medium',
      logic: typeof fields.logic === 'string' ? fields.logic.trim() : '',
      controlsRaw: typeof fields.controls === 'string' ? fields.controls.trim() : '',
      parentRuleId:
        typeof fields.parentRuleId === 'string' && fields.parentRuleId.trim()
          ? fields.parentRuleId.trim()
          : undefined,
    }
  })
}

/**
 * Parse the controls JSON array into normalized {authority, code} pairs, or
 * return the reason it is invalid. An empty input is valid (no controls).
 */
export function parseControls(raw: string): { controls: RuleControl[]; error?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { controls: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { controls: [], error: 'Controls must be valid JSON' }
  }
  if (!Array.isArray(parsed)) {
    return { controls: [], error: 'Controls must be a JSON array of {authority, code} objects' }
  }

  const controls: RuleControl[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { controls: [], error: 'Each control must be an object with an authority and a code' }
    }
    const { authority, code } = entry as { authority?: unknown; code?: unknown }
    if (typeof authority !== 'string' || !authority.trim() || typeof code !== 'string' || !code.trim()) {
      return { controls: [], error: 'Each control requires a non-empty authority and code' }
    }
    controls.push({ authority: authority.trim(), code: code.trim() })
  }
  return { controls }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate IOM custom-rule configurations against the Cloud Security rules API:
 * a unique name, a recognized cloud provider, a resource type, a valid severity,
 * Rego logic (required unless inheriting from a parent rule), and well-formed
 * compliance controls.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCloudIomRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Rule name must be ${MAX_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" — each rule name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    // description (required by the API)
    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })
    }

    // cloud provider
    if (!spec.cloudProvider) {
      errors.push({ field: `${prefix}.cloudProvider`, message: 'Cloud provider is required', code: 'required' })
    } else if (!(CLOUD_PROVIDERS as readonly string[]).includes(spec.cloudProvider)) {
      errors.push({
        field: `${prefix}.cloudProvider`,
        message: `Cloud provider must be one of: ${CLOUD_PROVIDERS.join(', ')}`,
        code: 'invalid_cloud_provider',
      })
    }

    // resource type
    if (!spec.resourceType) {
      errors.push({
        field: `${prefix}.resourceType`,
        message: 'Resource type is required, e.g. AWS::EC2::Instance or Microsoft.Compute/virtualMachines',
        code: 'required',
      })
    }

    // severity
    if (!(IOM_SEVERITIES as readonly string[]).includes(spec.severity)) {
      errors.push({
        field: `${prefix}.severity`,
        message: `Severity must be one of: ${IOM_SEVERITIES.join(', ')}`,
        code: 'invalid_severity',
      })
    }

    // logic (Rego) — required for a fully-custom rule; inherited when a parent is set
    if (!spec.parentRuleId && !spec.logic) {
      errors.push({
        field: `${prefix}.logic`,
        message: 'Rego logic is required unless the rule inherits from a parent rule',
        code: 'logic_required',
      })
    } else if (spec.parentRuleId && spec.logic) {
      warnings.push({
        field: `${prefix}.logic`,
        message: 'Logic is inherited from the parent rule — the value entered here may be ignored',
        code: 'logic_ignored',
      })
    }

    // controls (compliance pairs)
    if (spec.controlsRaw) {
      const { error } = parseControls(spec.controlsRaw)
      if (error) {
        errors.push({ field: `${prefix}.controls`, message: error, code: 'invalid_controls' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
