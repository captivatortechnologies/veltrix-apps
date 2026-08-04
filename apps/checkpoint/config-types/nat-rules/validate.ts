import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { objectKey, RULE_POSITIONS, strList, type RulePosition } from '../lib/checkpointShared'

// --- Shared types --------------------------------------------------------------

/** Verified against terraform-provider-checkpoint's resource_checkpoint_management_nat_rule.go
 *  Schema map: "method" — Optional string (default "static"). Only "hide" and
 *  "static" are documented NAT methods; this app defaults new rules to "hide"
 *  (the more common ad-hoc outbound-NAT use case) rather than the Terraform
 *  schema default, which is a UX choice, not a re-verified Check Point default. */
export const NAT_METHODS = ['hide', 'static'] as const
export type NatMethod = (typeof NAT_METHODS)[number]

export interface NatRuleSpec {
  itemId?: string
  /** name — the identity Check Point NAT rules are matched on, WITHIN their declared package.
   *  Rule naming requires management version R81+ (verified: cp_mgmt_nat_rule.py "Rule name.
   *  Available from R81 management version."). */
  name: string
  package: string
  enabled: boolean
  method: NatMethod
  /** Single object name each — NOT arrays (unlike access-rule source/destination/service). */
  originalSource: string
  originalDestination: string
  originalService: string
  translatedSource: string
  translatedDestination: string
  translatedService: string
  position: RulePosition
  /** Required when position is "above" or "below": the rule/section name to position relative to. */
  positionAnchor: string
  installOn: string[]
  comments: string
}

/** A rulebase member (original/translated/install-on entry) as returned by show-nat-rulebase. */
export type LiveNatMember = string | { name?: string; uid?: string }

/** A rule (or section) entry within show-nat-rulebase's `rulebase` array. */
export interface LiveNatRule {
  uid?: string
  name?: string
  /** "nat-rule" for a rule; other values are section/automatic-section headers, never managed here. */
  type?: string
  /** True for a rule Check Point generated from an object's own NAT settings — never matched/touched. */
  'auto-generated'?: boolean
  enabled?: boolean
  method?: string
  'original-source'?: LiveNatMember
  'original-destination'?: LiveNatMember
  'original-service'?: LiveNatMember
  'translated-source'?: LiveNatMember
  'translated-destination'?: LiveNatMember
  'translated-service'?: LiveNatMember
  'install-on'?: LiveNatMember[]
  comments?: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export const natRuleKey = objectKey
export const natPackageKey = objectKey

/** The live rule's single-member field name, whichever shape it comes back as. */
export function liveNatMemberName(value: LiveNatMember | undefined): string {
  if (!value) return ''
  return typeof value === 'string' ? value : (value.name ?? '')
}

/** Flatten install-on (strings or { name } summaries) to plain names. */
export function liveInstallOnNames(members: LiveNatMember[] | undefined): string[] {
  if (!Array.isArray(members)) return []
  return members
    .map((m) => (typeof m === 'string' ? m : m?.name))
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
}

export function extractNatRuleSpecs(canvas: CanvasSnapshot): NatRuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const rawMethod = asString(f.method).toLowerCase()
    const rawPosition = asString(f.position).toLowerCase() || 'bottom'
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      package: asString(f.package),
      enabled: asBool(f.enabled, true),
      method: (NAT_METHODS as readonly string[]).includes(rawMethod) ? (rawMethod as NatMethod) : 'hide',
      originalSource: asString(f.originalSource),
      originalDestination: asString(f.originalDestination),
      originalService: asString(f.originalService),
      translatedSource: asString(f.translatedSource),
      translatedDestination: asString(f.translatedDestination),
      translatedService: asString(f.translatedService),
      position: (RULE_POSITIONS as readonly string[]).includes(rawPosition) ? (rawPosition as RulePosition) : 'bottom',
      positionAnchor: asString(f.positionAnchor),
      installOn: strList(f.installOn),
      comments: asString(f.comments),
    }
  })
}

// --- Validate handler -----------------------------------------------------------

/**
 * Validate Check Point NAT-rule configurations: name + package are required;
 * name is unique per package (NAT rulebases are per-package, unlike access
 * rules' per-layer model); method is a constrained enum; position
 * "above"/"below" requires a positionAnchor.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractNatRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    }
    if (!spec.package) {
      errors.push({ field: `${prefix}.package`, message: 'Policy package is required', code: 'required' })
    }
    if (spec.name && spec.package) {
      const key = `${natPackageKey(spec.package)}::${natRuleKey(spec.name)}`
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate NAT rule "${spec.name}" in package "${spec.package}" — each name may only be declared once per package`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!(NAT_METHODS as readonly string[]).includes(spec.method)) {
      errors.push({ field: `${prefix}.method`, message: `Method must be one of: ${NAT_METHODS.join(', ')}`, code: 'invalid_method' })
    }
    if (!(RULE_POSITIONS as readonly string[]).includes(spec.position)) {
      errors.push({ field: `${prefix}.position`, message: `Position must be one of: ${RULE_POSITIONS.join(', ')}`, code: 'invalid_position' })
    } else if ((spec.position === 'above' || spec.position === 'below') && !spec.positionAnchor) {
      errors.push({
        field: `${prefix}.positionAnchor`,
        message: `Position "${spec.position}" needs the name of an existing rule or section to position relative to`,
        code: 'required',
      })
    }
    if (spec.installOn.some((v) => v.length === 0)) {
      errors.push({ field: `${prefix}.installOn`, message: 'Install On must not contain empty values', code: 'invalid_member' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
