import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { objectKey, strList } from '../lib/checkpointShared'

// --- Shared types --------------------------------------------------------------

/** Verified against CheckPointAnsibleMgmtCollection cp_mgmt_access_rule.py:
 *  action accepts "Accept, Drop, Ask, Inform, Reject, User Auth, Client Auth,
 *  Apply Layer". Only the 5 that need no extra configuration are modeled here
 *  — User Auth / Client Auth / Apply Layer need identity-awareness settings /
 *  an inline layer this config type does not manage (see README). */
export const ACTIONS = ['Accept', 'Drop', 'Reject', 'Ask', 'Inform'] as const
export type RuleAction = (typeof ACTIONS)[number]

/** track.type — the predefined Check Point track-type object name. */
export const TRACK_TYPES = ['None', 'Log', 'Alert'] as const
export type TrackType = (typeof TRACK_TYPES)[number]

/** The 4 position anchors add-access-rule / set-access-rule (as new-position)
 *  document — verified against the Ansible module + Terraform provider's
 *  position schema (top/bottom are absolute; above/below reference another
 *  rule or section by name). */
export const POSITIONS = ['top', 'bottom', 'above', 'below'] as const
export type RulePosition = (typeof POSITIONS)[number]

export interface AccessRuleSpec {
  itemId?: string
  /** name — the identity Check Point access rules are matched on, WITHIN layer+package. */
  name: string
  layer: string
  /** Policy package name — optional, only needed to disambiguate a layer name reused across packages. */
  package: string
  enabled: boolean
  action: RuleAction
  track: TrackType
  source: string[]
  sourceNegate: boolean
  destination: string[]
  destinationNegate: boolean
  service: string[]
  serviceNegate: boolean
  position: RulePosition
  /** Required when position is "above" or "below": the name of the rule/section to position relative to. */
  positionAnchor: string
  /** Gateways/clusters to install on. Left empty, install-on is never sent (existing/CP-default value is left alone). */
  installOn: string[]
  comments: string
}

/** A rulebase member (source/destination/service/install-on entry) as returned by show-access-rulebase. */
export type LiveMember = string | { name?: string; uid?: string }

/** A rule (or section) entry within show-access-rulebase's `rulebase` array. */
export interface LiveAccessRule {
  uid?: string
  name?: string
  /** "access-rule" for a rule, "access-section" for a section header (sections are never managed by this config type). */
  type?: string
  'rule-number'?: number
  source?: LiveMember[]
  'source-negate'?: boolean
  destination?: LiveMember[]
  'destination-negate'?: boolean
  service?: LiveMember[]
  'service-negate'?: boolean
  action?: LiveMember
  track?: { type?: LiveMember } | LiveMember
  enabled?: boolean
  comments?: string
  'install-on'?: LiveMember[]
  /** Present on a section header; this config type never reads into it (flat top-level rules only). */
  rulebase?: LiveAccessRule[]
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export const ruleKey = objectKey

/** Group key for a rule's target rulebase — a config type instance can span many layers/packages. */
export function ruleGroupKey(layer: string, pkg: string): string {
  return `${objectKey(pkg)}::${objectKey(layer)}`
}

/** Flatten a live member list (plain strings or { name } summaries) to member names. */
export function memberNames(members: LiveMember[] | undefined): string[] {
  if (!Array.isArray(members)) return []
  return members
    .map((m) => (typeof m === 'string' ? m : m?.name))
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
}

/** The live rule's action name ("Accept", "Drop", ...), whichever shape it comes back as. */
export function liveActionName(action: LiveMember | undefined): string {
  if (!action) return ''
  return typeof action === 'string' ? action : (action.name ?? '')
}

/** The live rule's track TYPE name ("None", "Log", "Alert"). */
export function liveTrackType(track: LiveAccessRule['track']): string {
  if (!track) return ''
  if (typeof track === 'string') return track
  const t = (track as { type?: LiveMember }).type
  if (!t) return ''
  return typeof t === 'string' ? t : (t.name ?? '')
}

export function extractAccessRuleSpecs(canvas: CanvasSnapshot): AccessRuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const rawAction = asString(f.action)
    const rawTrack = asString(f.track) || 'Log'
    const rawPosition = asString(f.position).toLowerCase() || 'bottom'
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      layer: asString(f.layer),
      package: asString(f.package),
      enabled: asBool(f.enabled, true),
      action: (ACTIONS as readonly string[]).includes(rawAction) ? (rawAction as RuleAction) : 'Drop',
      track: (TRACK_TYPES as readonly string[]).includes(rawTrack) ? (rawTrack as TrackType) : 'Log',
      source: strList(f.source),
      sourceNegate: asBool(f.sourceNegate, false),
      destination: strList(f.destination),
      destinationNegate: asBool(f.destinationNegate, false),
      service: strList(f.service),
      serviceNegate: asBool(f.serviceNegate, false),
      position: (POSITIONS as readonly string[]).includes(rawPosition) ? (rawPosition as RulePosition) : 'bottom',
      positionAnchor: asString(f.positionAnchor),
      installOn: strList(f.installOn),
      comments: asString(f.comments),
    }
  })
}

// --- Validate handler -----------------------------------------------------------

/**
 * Validate Check Point access-rule configurations: name + layer are
 * required; name is unique per (layer, package) — not globally, since
 * different layers legitimately reuse rule names; action/track/position are
 * constrained enums; position "above"/"below" requires a positionAnchor.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAccessRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    }
    if (!spec.layer) {
      errors.push({ field: `${prefix}.layer`, message: 'Access layer is required', code: 'required' })
    }
    if (spec.name && spec.layer) {
      const key = `${ruleGroupKey(spec.layer, spec.package)}::${ruleKey(spec.name)}`
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" in layer "${spec.layer}" — each name may only be declared once per layer+package`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!(ACTIONS as readonly string[]).includes(spec.action)) {
      errors.push({ field: `${prefix}.action`, message: `Action must be one of: ${ACTIONS.join(', ')}`, code: 'invalid_action' })
    }
    if (!(TRACK_TYPES as readonly string[]).includes(spec.track)) {
      errors.push({ field: `${prefix}.track`, message: `Track must be one of: ${TRACK_TYPES.join(', ')}`, code: 'invalid_track' })
    }
    if (!(POSITIONS as readonly string[]).includes(spec.position)) {
      errors.push({ field: `${prefix}.position`, message: `Position must be one of: ${POSITIONS.join(', ')}`, code: 'invalid_position' })
    } else if ((spec.position === 'above' || spec.position === 'below') && !spec.positionAnchor) {
      errors.push({
        field: `${prefix}.positionAnchor`,
        message: `Position "${spec.position}" needs the name of an existing rule or section to position relative to`,
        code: 'required',
      })
    }

    for (const [field, list] of [
      ['source', spec.source],
      ['destination', spec.destination],
      ['service', spec.service],
      ['installOn', spec.installOn],
    ] as const) {
      if (list.some((v) => v.length === 0)) {
        errors.push({ field: `${prefix}.${field}`, message: `${field} must not contain empty values`, code: 'invalid_member' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
