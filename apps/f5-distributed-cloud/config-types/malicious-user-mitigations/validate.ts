import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- F5 XC Malicious User Mitigation API constraints -------------------------
// https://docs.cloud.f5.com/docs-v2/api/malicious-user-mitigation
//
// GET/POST       /config/namespaces/{namespace}/malicious_user_mitigations         - list / create
// GET/PUT/DELETE /config/namespaces/{namespace}/malicious_user_mitigations/{name}  - read / update / delete
//
// spec.mitigation_type.rules is a REQUIRED list of { mitigation_action, threat_level }
// pairs. There are only three possible threat levels (low/medium/high), each a
// oneof with no additional fields, so this app models one action field per
// threat level rather than an open-ended rule list.

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_NAME_LENGTH = 63

export type MitigationAction = 'alert_only' | 'block_temporarily' | 'captcha_challenge' | 'javascript_challenge' | 'none'
export type ThreatLevel = 'low' | 'medium' | 'high'

const MITIGATION_ACTIONS: MitigationAction[] = [
  'alert_only',
  'block_temporarily',
  'captcha_challenge',
  'javascript_challenge',
  'none',
]

export interface MaliciousUserMitigationSpec {
  sectionName: string
  name: string
  description?: string
  disable: boolean
  lowThreatAction: MitigationAction
  mediumThreatAction: MitigationAction
  highThreatAction: MitigationAction
}

/** One rule as F5 XC represents it: a oneof-shaped mitigation_action + threat_level pair. */
export interface LiveMitigationRule {
  mitigation_action?: Partial<Record<MitigationAction, boolean>>
  threat_level?: Partial<Record<ThreatLevel, boolean>>
}

export interface LiveMaliciousUserMitigationSpec {
  mitigation_type?: { rules?: LiveMitigationRule[] }
  [key: string]: unknown
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function toAction(value: unknown, fallback: MitigationAction): MitigationAction {
  return typeof value === 'string' && (MITIGATION_ACTIONS as string[]).includes(value)
    ? (value as MitigationAction)
    : fallback
}

/** Each canvas item describes one F5 XC malicious user mitigation policy. */
export function extractMaliciousUserMitigationSpecs(canvas: CanvasSnapshot): MaliciousUserMitigationSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: toText(fields.description),
      disable: fields.disable === true,
      lowThreatAction: toAction(fields.lowThreatAction, 'alert_only'),
      mediumThreatAction: toAction(fields.mediumThreatAction, 'javascript_challenge'),
      highThreatAction: toAction(fields.highThreatAction, 'block_temporarily'),
    }
  })
}

/**
 * Validate malicious user mitigation configurations against the F5 XC API.
 * Static only:
 *   - name is required, DNS-1035, <= 63 chars, and unique within the canvas
 *   - each threat-level action must be one of the five known mitigation actions
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractMaliciousUserMitigationSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Mitigation policy name is required', code: 'required' })
      continue
    }
    if (!NAME_PATTERN.test(spec.name) || spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Name must be a DNS-1035 label: lowercase alphanumeric and hyphens, starting with a letter, 63 characters or fewer',
        code: 'invalid_name',
      })
    }
    const key = spec.name.toLowerCase()
    if (seenNames.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate mitigation policy "${spec.name}" - each policy may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    seenNames.add(key)

    for (const [field, value] of [
      ['lowThreatAction', spec.lowThreatAction],
      ['mediumThreatAction', spec.mediumThreatAction],
      ['highThreatAction', spec.highThreatAction],
    ] as const) {
      if (!(MITIGATION_ACTIONS as string[]).includes(value)) {
        errors.push({
          field: `${prefix}.${field}`,
          message: `${field} must be one of ${MITIGATION_ACTIONS.join(', ')}`,
          code: 'invalid_option',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
