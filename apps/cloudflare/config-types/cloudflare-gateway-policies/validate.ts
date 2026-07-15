import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Gateway (Zero Trust) policy constraints ----------------------

/** The account-scoped Gateway rules endpoint this config type manages. */
export const GATEWAY_RULES_PATH = '/gateway/rules'

/**
 * Supported Gateway rule actions. The valid set depends on the traffic/filter
 * type (e.g. `l4_override` is L4-only, `resolve`/`safesearch` are DNS-only), but
 * validation only checks membership — Cloudflare enforces the finer coupling.
 */
export const ACTIONS = [
  'allow',
  'block',
  'isolate',
  'resolve',
  'override',
  'l4_override',
  'safesearch',
] as const

/** Valid Gateway filter (traffic) types — one per line in the `filters` field. */
export const FILTER_TYPES = ['dns', 'http', 'l4'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface GatewayPolicySpec {
  sectionName: string
  /** The policy name — its logical identity (matched against the live rule name). */
  name: string
  action: string
  enabled: boolean
  precedence?: number
  /** The traffic types this rule applies to, e.g. ["dns"] / ["http"] / ["l4"]. */
  filters: string[]
  /** The Wirefilter traffic expression, e.g. any(dns.domains[*] == "example.com"). */
  traffic: string
  /** Raw JSON for advanced blocks (identity, device_posture, rule_settings). */
  ruleJson: string
}

/** Shape of a Gateway rule returned by GET /gateway/rules. */
export interface LiveGatewayPolicy {
  id?: string
  name?: string
  action?: string
  enabled?: boolean
  precedence?: number
  filters?: string[]
  traffic?: string
  identity?: unknown
  device_posture?: unknown
  rule_settings?: Record<string, unknown>
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/**
 * Result of parsing the rule_json textarea. NOT a discriminated union — the
 * platform's handler loader does not narrow `{ ok:true } | { ok:false }`, so
 * `value` and `error` are always-present nullable fields.
 */
export interface JsonParseResult {
  value: Record<string, unknown> | null
  error: string | null
}

export function parseJsonObject(raw: string | undefined): JsonParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/** Split a textarea value into trimmed, non-empty lines. */
export function splitLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one Cloudflare Gateway policy (rule). */
export function extractGatewayPolicySpecs(canvas: CanvasSnapshot): GatewayPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      action: typeof fields.action === 'string' ? fields.action.trim() : 'block',
      enabled: readBool(fields.enabled, true),
      precedence: readNumber(fields.precedence),
      filters: splitLines(fields.filters),
      traffic: typeof fields.traffic === 'string' ? fields.traffic.trim() : '',
      ruleJson: typeof fields.rule_json === 'string' ? fields.rule_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Gateway policy configurations: a name is required and unique across
 * the canvas, the action must be supported, a traffic expression is required, and
 * rule_json (when present) must parse to a JSON object. Unknown filter types are
 * warned (Cloudflare enforces the exact filter/action coupling at deploy time).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractGatewayPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else if (seen.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate gateway policy "${spec.name}" — each policy must be uniquely named`,
        code: 'duplicate_gateway_policy',
      })
    }
    if (spec.name) seen.add(spec.name)

    if (!spec.action || !ACTIONS.includes(spec.action as (typeof ACTIONS)[number])) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}"`, code: 'invalid_action' })
    }
    if (!spec.traffic) {
      errors.push({ field: `${prefix}.traffic`, message: 'Traffic filter expression is required', code: 'required' })
    }
    for (const filter of spec.filters) {
      if (!FILTER_TYPES.includes(filter as (typeof FILTER_TYPES)[number])) {
        warnings.push({
          field: `${prefix}.filters`,
          message: `Unknown filter type "${filter}" — expected one of ${FILTER_TYPES.join(', ')}`,
          code: 'invalid_filter',
        })
      }
    }
    if (spec.ruleJson.trim()) {
      const parsed = parseJsonObject(spec.ruleJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.rule_json`, message: `Rule JSON ${parsed.error}`, code: 'invalid_json' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
