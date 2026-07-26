import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Wiz automation-rule constraints -----------------------------------------

/** Trigger sources accepted by `CreateAutomationRuleInput.triggerSource`. */
export const TRIGGER_SOURCES = ['ISSUES', 'CLOUD_EVENTS', 'CONTROL', 'CONFIGURATION_FINDING'] as const

/** Trigger types accepted by `CreateAutomationRuleInput.triggerType`. */
export const TRIGGER_TYPES = ['CREATED', 'UPDATED', 'RESOLVED', 'REOPENED'] as const

/** Action template types accepted by `AutomationRuleActionInput.actionTemplateType`. */
export const ACTION_TEMPLATE_TYPES = [
  'AWS_EVENT_BRIDGE',
  'AWS_SECURITY_HUB',
  'AWS_SNS',
  'AZURE_DEVOPS',
  'AZURE_LOGIC_APPS',
  'AZURE_SENTINEL',
  'AZURE_SERVICE_BUS',
  'CISCO_WEBEX',
  'CLICK_UP_CREATE_TASK',
  'CORTEX_XSOAR',
  'CYWARE',
  'EMAIL',
  'FRESHSERVICE',
  'GCP_PUB_SUB',
  'GOOGLE_CHAT',
  'HUNTERS',
  'JIRA_ADD_COMMENT',
  'JIRA_CREATE_TICKET',
  'JIRA_TRANSITION_TICKET',
  'MICROSOFT_TEAMS',
  'OPSGENIE_CLOSE_ALERT',
  'OPSGENIE_CREATE_ALERT',
  'PAGER_DUTY_CREATE_INCIDENT',
  'PAGER_DUTY_RESOLVE_INCIDENT',
  'SERVICE_NOW_CREATE_TICKET',
  'SERVICE_NOW_UPDATE_TICKET',
  'SLACK',
  'SLACK_BOT',
  'SPLUNK',
  'SUMO_LOGIC',
  'TINES',
  'TORQ',
  'WEBHOOK',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AutomationRuleSpec {
  sectionName: string
  name: string
  description: string
  enabled: boolean
  triggerSource: string
  triggerTypes: string[]
  filters: string
  projectId: string
  integrationId: string
  actionTemplateType: string
  actionTemplateParams: string
}

/** An automation rule as returned by the `automationRules` list query. */
export interface LiveAutomationRule {
  id?: string
  name?: string
  enabled?: boolean | null
}

/**
 * An automation rule as returned by the single-rule read query. Only the scalar
 * fields are captured — the per-action `actionTemplateParams` is a GraphQL union
 * that cannot be read generically, so action bodies are not part of managed state.
 */
export interface FullAutomationRule {
  id?: string
  name?: string
  description?: string
  triggerSource?: string
  triggerType?: string[]
  filters?: unknown
  enabled?: boolean | null
}

/** The rule's logical identity: its name (case-insensitive, trimmed). */
export function ruleKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a canvas value that may be a `tags`/`multiselect` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Try to parse JSON text; empty text is treated as absent (ok, undefined value). */
export function tryParseJson(text: string): { value: unknown; ok: boolean } {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    return { value: JSON.parse(trimmed), ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

/** True when a value is a non-null, non-array JSON object. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Each canvas item describes one Wiz automation rule. */
export function extractAutomationRuleSpecs(canvas: CanvasSnapshot): AutomationRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      enabled: readBool(fields.enabled, true),
      triggerSource: str(fields.trigger_source) || 'ISSUES',
      triggerTypes: strList(fields.trigger_types),
      filters: typeof fields.filters === 'string' ? fields.filters.trim() : '',
      projectId: str(fields.project_id),
      integrationId: str(fields.integration_id),
      actionTemplateType: str(fields.action_template_type),
      actionTemplateParams:
        typeof fields.action_template_params === 'string' ? fields.action_template_params.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Wiz automation-rule configurations: name is required and unique across
 * the canvas (case-insensitive); the trigger source and every trigger type must
 * be supported; an action must pair a target integration id with a supported
 * action template type; and any JSON blob (filters, action template params) must
 * be a valid JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAutomationRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Automation rule name is required', code: 'required' })
    }

    if (!TRIGGER_SOURCES.includes(spec.triggerSource as (typeof TRIGGER_SOURCES)[number])) {
      errors.push({
        field: `${prefix}.trigger_source`,
        message: `Unsupported trigger source "${spec.triggerSource}"`,
        code: 'invalid_trigger_source',
      })
    }

    if (spec.triggerTypes.length === 0) {
      errors.push({
        field: `${prefix}.trigger_types`,
        message: 'At least one trigger type is required (e.g. CREATED)',
        code: 'required',
      })
    }
    for (const t of spec.triggerTypes) {
      if (!TRIGGER_TYPES.includes(t as (typeof TRIGGER_TYPES)[number])) {
        errors.push({
          field: `${prefix}.trigger_types`,
          message: `Unsupported trigger type "${t}"`,
          code: 'invalid_trigger_type',
        })
      }
    }

    if (!spec.integrationId) {
      errors.push({
        field: `${prefix}.integration_id`,
        message: 'An integration id is required — the Wiz integration the action delivers to',
        code: 'required',
      })
    }

    if (!spec.actionTemplateType) {
      errors.push({ field: `${prefix}.action_template_type`, message: 'An action type is required', code: 'required' })
    } else if (!ACTION_TEMPLATE_TYPES.includes(spec.actionTemplateType as (typeof ACTION_TEMPLATE_TYPES)[number])) {
      errors.push({
        field: `${prefix}.action_template_type`,
        message: `Unsupported action type "${spec.actionTemplateType}"`,
        code: 'invalid_action_type',
      })
    }

    // filters — optional; when present it must be a JSON object.
    const filters = tryParseJson(spec.filters)
    if (!filters.ok) {
      errors.push({ field: `${prefix}.filters`, message: 'Filters must be valid JSON', code: 'invalid_json' })
    } else if (filters.value !== undefined && !isJsonObject(filters.value)) {
      errors.push({ field: `${prefix}.filters`, message: 'Filters must be a JSON object', code: 'invalid_filters' })
    }

    // action template params — optional; when present it must be a JSON object.
    const params = tryParseJson(spec.actionTemplateParams)
    if (!params.ok) {
      errors.push({
        field: `${prefix}.action_template_params`,
        message: 'Action template params must be valid JSON',
        code: 'invalid_json',
      })
    } else if (params.value !== undefined && !isJsonObject(params.value)) {
      errors.push({
        field: `${prefix}.action_template_params`,
        message: 'Action template params must be a JSON object matching Wiz ActionTemplateParamsInput, e.g. {"webhook":{"body":"…"}}',
        code: 'invalid_action_params',
      })
    }

    if (spec.name) {
      const key = ruleKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate automation rule "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
