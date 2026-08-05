import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/f5xc'

// --- F5 XC Service Policy API constraints --------------------------------------
// https://docs.cloud.f5.com/docs/api/service-policy
//
// GET/POST       /config/namespaces/{namespace}/service_policys         - list / create
// GET/PUT/DELETE /config/namespaces/{namespace}/service_policys/{name}  - read / update / delete
// (irregular plural - "service_policys", confirmed from the decompiled
// grpc-gateway route literal, see canvas.yaml header comment)

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_NAME_LENGTH = 63

export type Algo = 'FIRST_MATCH' | 'ALLOW_OVERRIDES' | 'DENY_OVERRIDES'
export type ServerScope = 'any_server' | 'server_name'
export type ServicePolicyMode = 'allow_all_requests' | 'deny_all_requests' | 'allow_list' | 'deny_list' | 'rule_list'
export type ListDefaultAction = 'default_action_allow' | 'default_action_deny' | 'default_action_next_policy'

const ALGOS: Algo[] = ['FIRST_MATCH', 'ALLOW_OVERRIDES', 'DENY_OVERRIDES']
const MODES: ServicePolicyMode[] = ['allow_all_requests', 'deny_all_requests', 'allow_list', 'deny_list', 'rule_list']

export interface ServicePolicySpec {
  sectionName: string
  name: string
  description?: string
  disable: boolean
  algo: Algo
  serverScope: ServerScope
  serverName?: string
  mode: ServicePolicyMode
  listPrefixes: string[]
  listCountries: string[]
  listDefaultAction: ListDefaultAction
  ruleListJson: string
}

/** One custom rule as F5 XC represents it - metadata + a matcher/action spec. */
export interface LiveServicePolicyRule {
  metadata?: { name?: string; description?: string }
  spec?: Record<string, unknown>
}

export interface LiveServicePolicySpec {
  algo?: string
  allow_all_requests?: boolean
  deny_all_requests?: boolean
  allow_list?: Record<string, unknown>
  deny_list?: Record<string, unknown>
  rule_list?: { rules?: LiveServicePolicyRule[] }
  any_server?: boolean
  server_name?: string
  [key: string]: unknown
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Each canvas item describes one F5 XC service policy. */
export function extractServicePolicySpecs(canvas: CanvasSnapshot): ServicePolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const algo: Algo = (ALGOS as string[]).includes(fields.algo as string) ? (fields.algo as Algo) : 'FIRST_MATCH'
    const serverScope: ServerScope = fields.serverScope === 'server_name' ? 'server_name' : 'any_server'
    const mode: ServicePolicyMode = (MODES as string[]).includes(fields.mode as string)
      ? (fields.mode as ServicePolicyMode)
      : 'allow_list'
    const listDefaultAction: ListDefaultAction =
      fields.listDefaultAction === 'default_action_allow' || fields.listDefaultAction === 'default_action_deny'
        ? fields.listDefaultAction
        : 'default_action_next_policy'

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: toText(fields.description),
      disable: fields.disable === true,
      algo,
      serverScope,
      serverName: toText(fields.serverName),
      mode,
      listPrefixes: splitList(fields.listPrefixes),
      listCountries: splitList(fields.listCountries).map((c) => c.toUpperCase()),
      listDefaultAction,
      ruleListJson: typeof fields.ruleListJson === 'string' ? fields.ruleListJson : '',
    }
  })
}

/** Parse ruleListJson; returns null (not throws) on invalid JSON or shape. */
export function parseRuleList(json: string): LiveServicePolicyRule[] | null {
  if (!json.trim()) return null
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    if (
      !parsed.every(
        (rule) =>
          rule &&
          typeof rule === 'object' &&
          typeof rule.metadata?.name === 'string' &&
          rule.metadata.name.trim() &&
          rule.spec &&
          typeof rule.spec === 'object' &&
          (rule.spec.action === 'ALLOW' || rule.spec.action === 'DENY'),
      )
    ) {
      return null
    }
    return parsed as LiveServicePolicyRule[]
  } catch {
    return null
  }
}

/**
 * Validate service policy configurations against the F5 XC API. Static only:
 *   - name is required, DNS-1035, <= 63 chars, and unique within the canvas
 *   - serverName is required when serverScope is "server_name"
 *   - ruleListJson must parse to a non-empty array of { metadata.name, spec.action } when mode is "rule_list"
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractServicePolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Service policy name is required', code: 'required' })
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
        message: `Duplicate service policy "${spec.name}" - each policy may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    seenNames.add(key)

    if (spec.serverScope === 'server_name' && !spec.serverName) {
      errors.push({
        field: `${prefix}.serverName`,
        message: 'Server Name is required when Server Scope is "A specific server name"',
        code: 'required',
      })
    }

    if (spec.mode === 'rule_list' && !parseRuleList(spec.ruleListJson)) {
      errors.push({
        field: `${prefix}.ruleListJson`,
        message: 'Custom Rules must be a non-empty JSON array of { metadata: { name }, spec: { action: "ALLOW"|"DENY", ... } }',
        code: 'invalid_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
