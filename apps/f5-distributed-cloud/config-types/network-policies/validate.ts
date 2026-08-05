import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/f5xc'

// --- F5 XC Network Policy API constraints --------------------------------------
// https://docs.cloud.f5.com/docs-v2/api/network-policy
//
// GET/POST       /config/namespaces/{namespace}/network_policys         - list / create
// GET/PUT/DELETE /config/namespaces/{namespace}/network_policys/{name}  - read / update / delete
// (irregular plural - "network_policys", confirmed from the decompiled
// grpc-gateway route literal, see canvas.yaml header comment)

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_NAME_LENGTH = 63

export type EndpointMode = 'any' | 'inside_endpoints' | 'outside_endpoints' | 'label_selector'

export interface NetworkPolicyRule {
  metadata?: { name?: string; description?: string }
  action?: 'ALLOW' | 'DENY'
  endpoint?: Record<string, unknown>
  traffic?: Record<string, unknown>
}

export interface NetworkPolicySpec {
  sectionName: string
  name: string
  description?: string
  disable: boolean
  endpointMode: EndpointMode
  endpointExpressions: string[]
  ingressRulesJson: string
  egressRulesJson: string
}

export interface LiveNetworkPolicySpec {
  endpoint?: Record<string, unknown>
  rules?: { ingress_rules?: NetworkPolicyRule[]; egress_rules?: NetworkPolicyRule[] }
  [key: string]: unknown
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Each canvas item describes one F5 XC network policy. */
export function extractNetworkPolicySpecs(canvas: CanvasSnapshot): NetworkPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const endpointMode: EndpointMode =
      fields.endpointMode === 'inside_endpoints' ||
      fields.endpointMode === 'outside_endpoints' ||
      fields.endpointMode === 'label_selector'
        ? fields.endpointMode
        : 'any'

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: toText(fields.description),
      disable: fields.disable === true,
      endpointMode,
      endpointExpressions: splitList(fields.endpointExpressions),
      ingressRulesJson: typeof fields.ingressRulesJson === 'string' ? fields.ingressRulesJson : '',
      egressRulesJson: typeof fields.egressRulesJson === 'string' ? fields.egressRulesJson : '',
    }
  })
}

function isValidRule(rule: unknown): rule is NetworkPolicyRule {
  if (!rule || typeof rule !== 'object') return false
  const r = rule as NetworkPolicyRule
  return (
    typeof r.metadata?.name === 'string' &&
    r.metadata.name.trim().length > 0 &&
    (r.action === 'ALLOW' || r.action === 'DENY')
  )
}

/** Parse a rule-list JSON field. Blank is valid (no rules); invalid JSON/shape returns null. */
export function parseRuleListJson(json: string): NetworkPolicyRule[] | null {
  if (!json.trim()) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return null
    if (!parsed.every(isValidRule)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Validate network policy configurations against the F5 XC API. Static only:
 *   - name is required, DNS-1035, <= 63 chars, and unique within the canvas
 *   - endpointExpressions is required when endpointMode is "label_selector"
 *   - ingressRulesJson/egressRulesJson, when non-blank, must parse to an array
 *     of { metadata.name, action: "ALLOW"|"DENY" } rules
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractNetworkPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Network policy name is required', code: 'required' })
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
        message: `Duplicate network policy "${spec.name}" - each policy may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    seenNames.add(key)

    if (spec.endpointMode === 'label_selector' && spec.endpointExpressions.length === 0) {
      errors.push({
        field: `${prefix}.endpointExpressions`,
        message: 'At least one label expression is required when Endpoint Scope is "By label selector"',
        code: 'required',
      })
    }

    if (parseRuleListJson(spec.ingressRulesJson) === null) {
      errors.push({
        field: `${prefix}.ingressRulesJson`,
        message: 'Ingress Rules must be a JSON array of { metadata: { name }, action: "ALLOW"|"DENY", ... } (or blank)',
        code: 'invalid_json',
      })
    }
    if (parseRuleListJson(spec.egressRulesJson) === null) {
      errors.push({
        field: `${prefix}.egressRulesJson`,
        message: 'Egress Rules must be a JSON array of { metadata: { name }, action: "ALLOW"|"DENY", ... } (or blank)',
        code: 'invalid_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
