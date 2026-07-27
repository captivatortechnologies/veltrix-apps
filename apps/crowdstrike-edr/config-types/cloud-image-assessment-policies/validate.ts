import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'

// --- Falcon Cloud Security Image Assessment Policy API constraints ------------
//
// Policies live on the container-security collection:
//   GET    /container-security/entities/image-assessment-policies/v1  (read all)
//   POST   …                                                          (create: name + description)
//   PATCH  …?id=<id>                                                  (update: full policy_data)
//   DELETE …?id=<id>                                                  (delete)
//
// A policy carries a `policy_data.rules[]` array; each rule pairs an `action`
// (allow | alert | prevent) with `policy_rules_data.conditions[]` — the severity
// thresholds (CVE / misconfiguration / secret / malware / unassessed) that make
// the rule match. This config type models ONE action applied to a declared set
// of conditions (the canvas `rules` JSON), which is the common single-action
// policy shape. Policy groups and precedence are out of scope here (a policy is
// managed on its own).

export const IMAGE_POLICY_ACTIONS = ['allow', 'alert', 'prevent'] as const
export type ImagePolicyAction = (typeof IMAGE_POLICY_ACTIONS)[number]

/** Threshold kinds the conditions target — advisory only (soft-validated). */
export const KNOWN_CONDITION_TYPES = [
  'cve',
  'vulnerability',
  'misconfiguration',
  'secret',
  'malware',
  'unassessed',
] as const

export const MAX_POLICY_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ImagePolicySpec {
  sectionName: string
  name: string
  description?: string
  action: string
  enabled: boolean
  rulesRaw?: string
}

/** One image assessment policy rule as the API expects it. */
export interface ImagePolicyRule {
  action: string
  policy_rules_data: { conditions: Array<Record<string, unknown>> }
}

/** Shape of a policy returned by GET …/image-assessment-policies/v1. */
export interface LiveImagePolicy {
  id?: string
  name?: string
  description?: string
  is_enabled?: boolean
  policy_data?: { rules?: Array<Partial<ImagePolicyRule>> }
  /** Last modifier recorded by Falcon — used for drift attribution (best-effort). */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** Each canvas section describes one image assessment policy. */
export function extractImagePolicySpecs(canvas: CanvasSnapshot): ImagePolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      action:
        typeof fields.action === 'string' && fields.action.trim()
          ? fields.action.trim().toLowerCase()
          : 'alert',
      enabled: coerceBoolean(fields.enabled, true),
      rulesRaw:
        typeof fields.rules === 'string' && fields.rules.trim() ? fields.rules.trim() : undefined,
    }
  })
}

/**
 * Parse the conditions JSON: an array of condition objects (severity thresholds
 * by CVE / misconfiguration / secret / malware / unassessed). Returns the parsed
 * conditions plus any structural errors.
 */
export function parseImagePolicyConditions(raw: string | undefined): {
  conditions: Array<Record<string, unknown>>
  errors: string[]
} {
  if (!raw) return { conditions: [], errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      conditions: [],
      errors: [`Rules is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  if (!Array.isArray(parsed)) {
    return { conditions: [], errors: ['Rules must be a JSON array of condition objects'] }
  }

  const conditions: Array<Record<string, unknown>> = []
  const errors: string[] = []
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`Rule #${index + 1}: must be a JSON object describing a condition`)
      return
    }
    conditions.push(entry as Record<string, unknown>)
  })

  return { conditions, errors }
}

/**
 * Build the `policy_data` the API expects from the declared action + conditions.
 * A single rule pairs the policy action with all declared conditions.
 */
export function buildPolicyData(
  action: string,
  conditions: Array<Record<string, unknown>>,
): { rules: ImagePolicyRule[] } {
  return { rules: [{ action, policy_rules_data: { conditions } }] }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate image assessment policy configurations against the API constraints:
 * name presence/length, action enum, and the conditions JSON shape.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractImagePolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_POLICY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Policy name must be ${MAX_POLICY_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (spec.name.toLowerCase() === 'default') {
        errors.push({
          field: `${prefix}.name`,
          message: 'The built-in Default image assessment policy cannot be managed by this app',
          code: 'reserved_name',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // action
    if (!(IMAGE_POLICY_ACTIONS as readonly string[]).includes(spec.action)) {
      errors.push({
        field: `${prefix}.action`,
        message: `Action must be one of: ${IMAGE_POLICY_ACTIONS.join(', ')}`,
        code: 'invalid_action',
      })
    }

    // rules (conditions JSON)
    const { conditions, errors: conditionErrors } = parseImagePolicyConditions(spec.rulesRaw)
    for (const message of conditionErrors) {
      errors.push({ field: `${prefix}.rules`, message, code: 'invalid_rules' })
    }
    if (conditionErrors.length === 0 && conditions.length === 0) {
      warnings.push({
        field: `${prefix}.rules`,
        message:
          'No rule conditions declared — the policy will not match any images until thresholds are added',
        code: 'empty_rules',
      })
    }
    // Soft nudge: a "prevent" policy with no conditions blocks nothing.
    if (spec.action === 'prevent' && conditionErrors.length === 0 && conditions.length === 0) {
      warnings.push({
        field: `${prefix}.action`,
        message: 'Action is "prevent" but no conditions are declared — nothing will be prevented',
        code: 'prevent_without_conditions',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
