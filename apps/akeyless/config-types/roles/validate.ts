import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { toStringList } from '../../lib/akeyless'

// --- Akeyless Roles API constraints -------------------------------------------
// https://docs.akeyless.io
//   POST /create-role, /update-role, /delete-role, /get-role, /list-roles
//   POST /set-role-rule, /delete-role-rule            (rules, additive-only here)
//   POST /assoc-role-am, /update-assoc, /delete-assoc (auth-method associations, full replace)
// A role's identity is its NAME - Akeyless has no upsert.

export const RULE_TYPES = ['item-rule', 'target-rule', 'role-rule', 'auth-method-rule'] as const
export type RuleType = (typeof RULE_TYPES)[number]
export const CAPABILITIES = ['read', 'create', 'update', 'delete', 'list', 'deny'] as const

export interface RuleSpec {
  path: string
  ruleType: RuleType
  capability: string[]
}

export interface AssocSpec {
  authMethodName: string
  subClaims: Record<string, string[]>
  caseSensitive: boolean
}

export interface RoleSpec {
  sectionName: string
  name: string
  description: string
  deleteProtection: boolean
  auditAccess: string
  analyticsAccess: string
  gwAnalyticsAccess: string
  sraReportsAccess: string
  usageReportsAccess: string
  eventCenterAccess: string
  isiAccess: string
  reverseRbacAccess: string
  eventForwardersAccess: string
  eventForwardersName: string[]
  rules: RuleSpec[]
  rulesRaw: unknown
  rulesParseError: string | null
  authMethodAssociations: AssocSpec[]
  assocRaw: unknown
  assocParseError: string | null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
function bool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Parse a textarea field's value as JSON. Returns [parsed, error] - error is null on success. */
function parseJsonArray(value: unknown): [unknown[], string | null] {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return [[], null]
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return [[], 'Must be a JSON array']
    return [parsed, null]
  } catch (e) {
    return [[], `Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`]
  }
}

function normalizeSubClaims(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = toStringList(value)
  }
  return out
}

function normalizeRule(raw: unknown): RuleSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const path = str(r.path)
  if (!path) return null
  const ruleType = (RULE_TYPES as readonly string[]).includes(str(r.ruleType)) ? (str(r.ruleType) as RuleType) : 'item-rule'
  return { path, ruleType, capability: toStringList(r.capability) }
}

function normalizeAssoc(raw: unknown): AssocSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const authMethodName = str(r.authMethodName)
  if (!authMethodName) return null
  return { authMethodName, subClaims: normalizeSubClaims(r.subClaims), caseSensitive: r.caseSensitive !== false }
}

/** Each canvas item describes one Akeyless role. */
export function extractRoleSpecs(canvas: CanvasSnapshot): RoleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const f = (section.fields ?? {}) as Record<string, unknown>
    const [rulesRaw, rulesParseError] = parseJsonArray(f.rules)
    const [assocRaw, assocParseError] = parseJsonArray(f.authMethodAssociations)

    return {
      sectionName: section.name,
      name: str(f.name),
      description: str(f.description),
      deleteProtection: bool(f.deleteProtection),
      auditAccess: str(f.auditAccess),
      analyticsAccess: str(f.analyticsAccess),
      gwAnalyticsAccess: str(f.gwAnalyticsAccess),
      sraReportsAccess: str(f.sraReportsAccess),
      usageReportsAccess: str(f.usageReportsAccess),
      eventCenterAccess: str(f.eventCenterAccess),
      isiAccess: str(f.isiAccess),
      reverseRbacAccess: str(f.reverseRbacAccess),
      eventForwardersAccess: str(f.eventForwardersAccess),
      eventForwardersName: toStringList(f.eventForwardersName),
      rules: rulesRaw.map(normalizeRule).filter((r): r is RuleSpec => r !== null),
      rulesRaw,
      rulesParseError,
      authMethodAssociations: assocRaw.map(normalizeAssoc).filter((a): a is AssocSpec => a !== null),
      assocRaw,
      assocParseError,
    }
  })
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRoleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate role "${spec.name}" - each role name may only be declared once per canvas`,
        code: 'duplicate_role',
      })
    }
    if (spec.name) seenNames.add(spec.name)

    if (spec.rulesParseError) {
      errors.push({ field: `${prefix}.rules`, message: `Rules: ${spec.rulesParseError}`, code: 'invalid_json' })
    } else {
      for (let i = 0; i < spec.rules.length; i++) {
        const rule = spec.rules[i]
        if (rule.capability.length === 0) {
          errors.push({
            field: `${prefix}.rules[${i}]`,
            message: `Rule "${rule.path}" requires at least one capability`,
            code: 'required',
          })
        }
        const badCaps = rule.capability.filter((c) => !(CAPABILITIES as readonly string[]).includes(c))
        if (badCaps.length > 0) {
          errors.push({
            field: `${prefix}.rules[${i}]`,
            message: `Rule "${rule.path}" has invalid capabilities: ${badCaps.join(', ')} (allowed: ${CAPABILITIES.join(', ')})`,
            code: 'invalid_value',
          })
        }
      }
      const seenRuleKeys = new Set<string>()
      for (const rule of spec.rules) {
        const key = `${rule.ruleType}::${rule.path}`
        if (seenRuleKeys.has(key)) {
          errors.push({
            field: `${prefix}.rules`,
            message: `Duplicate rule for path "${rule.path}" and type "${rule.ruleType}"`,
            code: 'duplicate_rule',
          })
        }
        seenRuleKeys.add(key)
      }
    }

    if (spec.assocParseError) {
      errors.push({
        field: `${prefix}.authMethodAssociations`,
        message: `Auth Method Associations: ${spec.assocParseError}`,
        code: 'invalid_json',
      })
    } else {
      const seenAssocNames = new Set<string>()
      for (const assoc of spec.authMethodAssociations) {
        if (seenAssocNames.has(assoc.authMethodName)) {
          errors.push({
            field: `${prefix}.authMethodAssociations`,
            message: `Duplicate association for auth method "${assoc.authMethodName}"`,
            code: 'duplicate_association',
          })
        }
        seenAssocNames.add(assoc.authMethodName)
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
