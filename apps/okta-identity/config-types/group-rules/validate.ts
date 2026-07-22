import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Group Rules API constraints ----------------------------------------

/** A group rule's name is capped at 50 characters by the Okta API. */
export const MAX_GROUP_RULE_NAME_LENGTH = 50

/** Expression-language version used by a group-rule condition. */
export const OKTA_EXPRESSION_TYPE = 'urn:okta:expression:1.0'

/** The two lifecycle statuses a rule can be authored in. */
export const GROUP_RULE_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type GroupRuleStatus = (typeof GROUP_RULE_STATUSES)[number]

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface GroupRuleSpec {
  sectionName: string
  /** Rule name — the logical identity live rules are matched on. */
  name: string
  /** Okta Expression Language string, e.g. user.department=="Engineering". */
  expression: string
  /** Okta group ids matching users are assigned to (the rule's actions). */
  groupIds: string[]
  /**
   * Desired lifecycle status. Rules are always CREATED inactive and activated
   * explicitly when this is ACTIVE (see deploy) — this is the target state.
   */
  status: GroupRuleStatus
}

/** Shape of a group rule returned by GET /groups/rules and /groups/rules/{id}. */
export interface LiveGroupRule {
  id?: string
  type?: string
  /** ACTIVE | INACTIVE | INVALID — changed only via the lifecycle endpoints. */
  status?: string
  name?: string
  /** Some tenants surface a system flag on managed objects — never delete those. */
  system?: boolean
  conditions?: {
    expression?: { value?: string; type?: string }
  }
  actions?: {
    assignUserToGroups?: { groupIds?: string[] }
  }
}

/**
 * Normalize a groupIds value (a `tags` array OR a comma/space-separated string)
 * to a plain string[]: trims each entry and drops empties. Shared by validate
 * (to count/require ids) and deploy (to build the actions block).
 */
export function normalizeGroupIds(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : []
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** The Okta group ids a live rule assigns to, as a plain string[]. */
export function liveGroupIds(live: LiveGroupRule): string[] {
  return (live.actions?.assignUserToGroups?.groupIds ?? []).map((g) => String(g))
}

/** The Okta EL expression string of a live rule (empty when absent). */
export function liveExpression(live: LiveGroupRule): string {
  return typeof live.conditions?.expression?.value === 'string' ? live.conditions.expression.value : ''
}

// Tokens that make an expression evaluate to a Boolean: comparisons, logical
// operators, and Okta EL functions that RETURN a boolean.
const BOOLEAN_OPERATORS = /(==|!=|<=|>=|<|>)|(&&|\|\|)|\b(AND|OR)\b/i
const BOOLEAN_FUNCTIONS =
  /\b(stringContains|startsWith|endsWith|matches|contains|isMemberOfGroupName|equals|isEmpty|isNotEmpty|isPresent)\s*\(/i
// String-BUILDING signals: concatenation, or EL functions that return a String.
const STRING_BUILDERS =
  /\+|\b(toUpperCase|toLowerCase|substringBefore|substringAfter|substringBetween|substring|append|replaceFirst|replace|trim|concat|convert)\s*\(/i

/**
 * Conservative heuristic: true when an expression looks like it BUILDS A STRING
 * (concatenation / string-transform functions) yet has NO comparison, logical
 * operator, or boolean-returning function — so it probably does not resolve to a
 * Boolean, which a group-rule condition requires. Deliberately quiet: any boolean
 * signal suppresses the warning, so valid conditions (incl. those that use string
 * functions inside a comparison, e.g. substringAfter(...) == "x") never trip it.
 * Not authoritative — Okta type-checks the EL at create/deploy.
 */
export function expressionLikelyNotBoolean(expression: string): boolean {
  const e = (expression ?? '').trim()
  if (!e) return false
  if (BOOLEAN_OPERATORS.test(e) || BOOLEAN_FUNCTIONS.test(e)) return false
  return STRING_BUILDERS.test(e)
}

/**
 * True when two group-id lists describe the same SET (order-independent). The
 * `actions` block is immutable, so deploy uses this to decide update-in-place
 * (same set) vs delete + recreate (different set).
 */
export function sameGroupIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, i) => value === sortedB[i])
}

/** Each canvas item describes one Okta dynamic group rule. */
export function extractGroupRuleSpecs(canvas: CanvasSnapshot): GroupRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawStatus = typeof fields.status === 'string' ? fields.status.trim().toUpperCase() : ''
    // Default to ACTIVE — matches the canvas default and the authoring intent.
    const status: GroupRuleStatus = rawStatus === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      expression: typeof fields.expression === 'string' ? fields.expression.trim() : '',
      groupIds: normalizeGroupIds(fields.groupIds),
      status,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate group-rule configurations against Okta Group Rules API constraints:
 * a name (<= 50 chars), an expression and at least one target group id are
 * required, and the rule NAME — a rule's logical identity — must be unique
 * across the canvas.
 *
 * Static rules only — NO network. Whether the target group ids exist, and
 * whether the expression is a valid Okta EL, are only knowable live (Okta
 * validates the expression when the rule is created / activated).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractGroupRuleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 50 chars, and the logical identity
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group rule name is required', code: 'required' })
    } else if (spec.name.length > MAX_GROUP_RULE_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Group rule name must be ${MAX_GROUP_RULE_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // expression — required Okta EL condition
    if (!spec.expression) {
      errors.push({
        field: `${prefix}.expression`,
        message: 'Rule expression is required — an Okta Expression Language condition, e.g. user.department=="Engineering"',
        code: 'required',
      })
    } else if (expressionLikelyNotBoolean(spec.expression)) {
      // Heuristic (not authoritative — Okta type-checks the EL at deploy): the
      // expression uses string-building but has no comparison/logical operator,
      // so it probably yields a String, which a group-rule condition may not.
      warnings.push({
        field: `${prefix}.expression`,
        message:
          'This expression looks like it builds a string rather than a true/false condition. A group ' +
          'rule must resolve to a Boolean — e.g. user.department == "Sales" or ' +
          'String.stringContains(user.email, "@acme.com"). Okta will reject a non-Boolean expression on deploy.',
        code: 'expression_not_boolean',
      })
    }

    // groupIds — at least one target group id
    if (spec.groupIds.length === 0) {
      errors.push({
        field: `${prefix}.groupIds`,
        message: 'At least one target group id is required — the rule assigns matching users to these groups',
        code: 'required',
      })
    }

    // Rule NAME is the logical identity — dedupe on it. Matched exactly (not
    // case-folded) so it agrees with the name-based live match in deploy / drift;
    // two names differing only in case are treated as distinct.
    if (spec.name) {
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate group rule "${spec.name}" — each rule name may only be declared once per canvas`,
          code: 'duplicate_rule',
        })
      }
      seenNames.add(spec.name)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
