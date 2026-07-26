import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare classic Page Rules (/pagerules) ------------------------------
//
// A Page Rule has ONE url target — { target: "url", constraint: { operator:
// "matches", value: <pattern> } } — and a set of actions. The URL pattern is the
// rule's natural identity (Cloudflare assigns the server id). Actions either
// forward (a single forwarding_url) OR override settings — never both.

/** The only target type / operator Cloudflare supports for a Page Rule. */
export const TARGET = 'url'
export const OPERATOR = 'matches'
/** The action id that forwards (redirects); it cannot be combined with others. */
export const FORWARDING_ACTION = 'forwarding_url'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface PageRuleSpec {
  sectionName: string
  urlPattern: string
  /** Natural key derived from the URL pattern — the reconciliation key. */
  key: string
  actionsJson: string
  priority: number
  enabled: boolean
}

/** A Page Rule target as returned/accepted by the API. */
export interface LivePageRuleTarget {
  target?: string
  constraint?: { operator?: string; value?: string }
}

/** A Page Rule action as returned/accepted by the API. */
export interface LivePageRuleAction {
  id?: string
  value?: unknown
}

/** Shape of a Page Rule returned by GET /pagerules. */
export interface LivePageRule {
  id?: string
  targets?: LivePageRuleTarget[]
  actions?: LivePageRuleAction[]
  priority?: number
  status?: string
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

/**
 * Result of parsing actions_json. NOT a discriminated union — the platform's
 * handler loader does not narrow `{ ok:true } | { ok:false }`, so `value` and
 * `error` are always-present nullable fields (mirrors the redirect type).
 */
export interface JsonArrayParseResult {
  value: unknown[] | null
  error: string | null
}

export function parseJsonArray(raw: string | undefined): JsonArrayParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { value: null, error: 'must be a JSON array of actions' }
  return { value: parsed, error: null }
}

/** The URL match pattern is the rule's identity; matching is case-insensitive. */
export function pageRuleKey(urlPattern: string): string {
  return urlPattern.trim().toLowerCase()
}

/** Pull the url target's pattern out of a live rule (its natural key source). */
export function livePageRulePattern(rule: LivePageRule): string {
  const targets = rule.targets ?? []
  const urlTarget = targets.find((t) => t.target === TARGET) ?? targets[0]
  return typeof urlTarget?.constraint?.value === 'string' ? urlTarget.constraint.value : ''
}

/** Each canvas item describes one Page Rule, in priority order. */
export function extractPageRuleSpecs(canvas: CanvasSnapshot): PageRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const urlPattern = typeof fields.url_pattern === 'string' ? fields.url_pattern.trim() : ''
    return {
      sectionName: section.name,
      urlPattern,
      key: pageRuleKey(urlPattern),
      actionsJson: typeof fields.actions_json === 'string' ? fields.actions_json : '',
      priority: readNumber(fields.priority, 1),
      enabled: readBool(fields.enabled, true),
    }
  })
}

/** Extract the action ids from a parsed actions array (objects with a string id). */
export function actionIds(actions: unknown[]): string[] {
  return actions
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a))
    .map((a) => (typeof a.id === 'string' ? a.id.trim() : ''))
    .filter((id) => id.length > 0)
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Page Rule configurations: a URL pattern is required and unique across
 * the canvas (its natural key), actions_json is required and must parse to a
 * non-empty JSON array of action objects each carrying a string id, and a
 * forwarding_url action must be the only action (Cloudflare rejects redirect +
 * settings on the same rule).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPageRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.urlPattern) {
      errors.push({ field: `${prefix}.url_pattern`, message: 'URL match pattern is required', code: 'required' })
    } else if (seen.has(spec.key)) {
      errors.push({
        field: `${prefix}.url_pattern`,
        message: `Duplicate URL pattern "${spec.urlPattern}" — each Page Rule must match a unique pattern`,
        code: 'duplicate_page_rule',
      })
    }
    seen.add(spec.key)

    if (!spec.actionsJson.trim()) {
      errors.push({ field: `${prefix}.actions_json`, message: 'Actions (JSON array) is required', code: 'required' })
      continue
    }

    const parsed = parseJsonArray(spec.actionsJson)
    if (parsed.error) {
      errors.push({ field: `${prefix}.actions_json`, message: `Actions ${parsed.error}`, code: 'invalid_json' })
      continue
    }
    const actions = parsed.value ?? []
    if (actions.length === 0) {
      errors.push({ field: `${prefix}.actions_json`, message: 'At least one action is required', code: 'required' })
      continue
    }
    const ids = actionIds(actions)
    if (ids.length !== actions.length) {
      errors.push({
        field: `${prefix}.actions_json`,
        message: 'Every action must be an object with a non-empty "id"',
        code: 'invalid_action',
      })
    }
    if (ids.includes(FORWARDING_ACTION) && ids.length > 1) {
      errors.push({
        field: `${prefix}.actions_json`,
        message: 'A forwarding_url action cannot be combined with other actions — a rule either forwards or overrides settings, not both',
        code: 'forwarding_conflict',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
