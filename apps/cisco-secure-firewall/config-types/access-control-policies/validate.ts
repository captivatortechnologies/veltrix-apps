import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { FmcObject, UpsertSpec } from '../../lib/fmc'

// Verified against CiscoDevNet/terraform-provider-fmc's
// gen/definitions/access_control_policy.yaml `rest_endpoint`. Note the real
// FMC path segment is `accesspolicies`, NOT `accesscontrolpolicies`.
export const ACCESS_POLICIES_PATH = '/policy/accesspolicies'

export const DEFAULT_ACTIONS = ['BLOCK', 'TRUST', 'PERMIT', 'NETWORK_DISCOVERY', 'INHERIT_FROM_PARENT'] as const
export type DefaultAction = (typeof DEFAULT_ACTIONS)[number]

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

export interface AccessControlPolicySpec {
  sectionName: string
  name: string
  description: string
  defaultAction: string
  logBegin: boolean
  logEnd: boolean
  sendEventsToFmc: boolean
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function coerceBool(value: unknown, def: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return def
}

export function extractAccessControlPolicySpecs(canvas: CanvasSnapshot): AccessControlPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      defaultAction: str(fields.default_action) || 'BLOCK',
      logBegin: coerceBool(fields.default_action_log_begin, false),
      logEnd: coerceBool(fields.default_action_log_end, false),
      sendEventsToFmc: coerceBool(fields.default_action_send_events_to_fmc, false),
    }
  })
}

/** Build the FMC body fields. `defaultAction` is a nested object per the FMC schema. */
export function buildAccessControlPolicyFields(spec: AccessControlPolicySpec): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    defaultAction: {
      action: spec.defaultAction,
      logBegin: spec.logBegin,
      logEnd: spec.logEnd,
      sendEventsToFMC: spec.sendEventsToFmc,
    },
  }
  if (spec.description) fields.description = spec.description
  return fields
}

export function accessControlPolicyUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractAccessControlPolicySpecs(canvas)
    .filter((s) => s.name && DEFAULT_ACTIONS.includes(s.defaultAction as DefaultAction))
    .map((s) => ({ name: s.name, fields: buildAccessControlPolicyFields(s) }))
}

export function accessControlPolicyDriftDiffs(spec: AccessControlPolicySpec, live: FmcObject): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const liveDefaultAction = live.defaultAction as { action?: string; logBegin?: boolean; logEnd?: boolean; sendEventsToFMC?: boolean } | undefined
  const liveAction = liveDefaultAction?.action ?? ''
  if (liveAction && liveAction !== spec.defaultAction) {
    diffs.push({ field: `${spec.name}.default_action`, expected: spec.defaultAction, actual: liveAction, severity: 'critical' })
  }
  if (typeof liveDefaultAction?.logBegin === 'boolean' && liveDefaultAction.logBegin !== spec.logBegin) {
    diffs.push({ field: `${spec.name}.default_action_log_begin`, expected: String(spec.logBegin), actual: String(liveDefaultAction.logBegin), severity: 'info' })
  }
  if (typeof liveDefaultAction?.logEnd === 'boolean' && liveDefaultAction.logEnd !== spec.logEnd) {
    diffs.push({ field: `${spec.name}.default_action_log_end`, expected: String(spec.logEnd), actual: String(liveDefaultAction.logEnd), severity: 'info' })
  }
  const liveDescription = typeof live.description === 'string' ? live.description : ''
  if (spec.description && liveDescription !== spec.description) {
    diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: liveDescription || 'not set', severity: 'info' })
  }
  return diffs
}

/** Validate access control policies: a valid name and a supported default action are required; names are unique. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractAccessControlPolicySpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else if (!NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: 'FMC object names allow letters, numbers, periods, underscores and hyphens only - no spaces',
        code: 'invalid_name',
      })
    }

    if (!DEFAULT_ACTIONS.includes(spec.defaultAction as DefaultAction)) {
      errors.push({ field: `${prefix}.default_action`, message: `Unsupported default action "${spec.defaultAction}"`, code: 'invalid_default_action' })
    }

    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate policy "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
