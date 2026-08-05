import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Bot Management (zone-scoped singleton) -------------------------
//
// The zone's Bot Management configuration is a singleton object that always
// exists (/zones/{zone_id}/bot_management) — only read (GET) and updated (PUT),
// never created or deleted. There is exactly one per zone, so the canvas item
// has no natural identity field and is capped at one row by the template
// (maxItems: 1).
//
// Cloudflare's schema is a plan-gated oneOf: which fields are valid depends on
// whether the zone has Bot Fight Mode, Super Bot Fight Mode (Pro+) or the
// Enterprise Bot Management subscription. The "Shared Config" fields below
// (ai_bots_protection, crawler_protection, content_bots_protection,
// cf_robots_variant, enable_js, using_latest_model) are valid on every plan;
// `advanced_json` merges plan-specific fields on top, the same "advanced JSON"
// convention app_json / rule_json use elsewhere in this app.

export const AI_BOTS_PROTECTION_VALUES = ['block', 'only_on_ad_pages', 'disabled'] as const
export const CRAWLER_PROTECTION_VALUES = ['enabled', 'disabled'] as const
export const CONTENT_BOTS_PROTECTION_VALUES = ['block', 'disabled'] as const
export const CF_ROBOTS_VARIANT_VALUES = ['off', 'policy_only'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface BotManagementSpec {
  sectionName: string
  aiBotsProtection: string
  crawlerProtection: string
  contentBotsProtection: string
  cfRobotsVariant: string
  enableJs: boolean
  usingLatestModel: boolean
  /** Raw JSON text merged onto the body at the top level (plan-specific fields). */
  advancedJson: string
}

/** Shape of the object returned by GET /bot_management (a superset across every plan variant). */
export interface LiveBotManagement {
  ai_bots_protection?: string
  crawler_protection?: string
  content_bots_protection?: string
  cf_robots_variant?: string
  enable_js?: boolean
  using_latest_model?: boolean
  fight_mode?: boolean
  sbfm_definitely_automated?: string
  sbfm_likely_automated?: string
  sbfm_verified_bots?: string
  sbfm_static_resource_protection?: boolean
  optimize_wordpress?: boolean
  suppress_session_score?: boolean
  auto_update_model?: boolean
  bm_cookie_enabled?: boolean
  is_robots_txt_managed?: boolean
  /** Read-only — Cloudflare reports settings active from a plan change; never sent back. */
  stale_zone_configuration?: unknown
  [key: string]: unknown
}

/**
 * Result of parsing advanced_json. NOT a discriminated union — the platform's
 * handler loader does not narrow `{ ok:true } | { ok:false }`, so `value` and
 * `error` are always-present nullable fields.
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

/** The single canvas item describing the zone's Bot Management settings, if declared. */
export function extractBotManagementSpec(canvas: CanvasSnapshot): BotManagementSpec | null {
  const section = (canvas.sections ?? [])[0]
  if (!section) return null
  const fields = section.fields ?? {}
  return {
    sectionName: section.name,
    aiBotsProtection:
      typeof fields.ai_bots_protection === 'string' && fields.ai_bots_protection.trim()
        ? fields.ai_bots_protection.trim()
        : 'block',
    crawlerProtection:
      typeof fields.crawler_protection === 'string' && fields.crawler_protection.trim()
        ? fields.crawler_protection.trim()
        : 'disabled',
    contentBotsProtection:
      typeof fields.content_bots_protection === 'string' && fields.content_bots_protection.trim()
        ? fields.content_bots_protection.trim()
        : 'disabled',
    cfRobotsVariant:
      typeof fields.cf_robots_variant === 'string' && fields.cf_robots_variant.trim()
        ? fields.cf_robots_variant.trim()
        : 'off',
    enableJs: fields.enable_js !== false,
    usingLatestModel: fields.using_latest_model !== false,
    advancedJson: typeof fields.advanced_json === 'string' ? fields.advanced_json : '',
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate the zone's Bot Management configuration: the select fields must be
 * one of their supported values and advanced_json (when present) must parse to
 * a JSON object. There is no identity or uniqueness to check — it is a
 * singleton, capped at one row by the canvas template.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const spec = extractBotManagementSpec(ctx.canvas)
  if (!spec) return { valid: true, errors, warnings }

  const prefix = spec.sectionName

  if (!AI_BOTS_PROTECTION_VALUES.includes(spec.aiBotsProtection as (typeof AI_BOTS_PROTECTION_VALUES)[number])) {
    errors.push({
      field: `${prefix}.ai_bots_protection`,
      message: `Unsupported value "${spec.aiBotsProtection}"`,
      code: 'invalid_value',
    })
  }
  if (!CRAWLER_PROTECTION_VALUES.includes(spec.crawlerProtection as (typeof CRAWLER_PROTECTION_VALUES)[number])) {
    errors.push({
      field: `${prefix}.crawler_protection`,
      message: `Unsupported value "${spec.crawlerProtection}"`,
      code: 'invalid_value',
    })
  }
  if (
    !CONTENT_BOTS_PROTECTION_VALUES.includes(spec.contentBotsProtection as (typeof CONTENT_BOTS_PROTECTION_VALUES)[number])
  ) {
    errors.push({
      field: `${prefix}.content_bots_protection`,
      message: `Unsupported value "${spec.contentBotsProtection}"`,
      code: 'invalid_value',
    })
  }
  if (!CF_ROBOTS_VARIANT_VALUES.includes(spec.cfRobotsVariant as (typeof CF_ROBOTS_VARIANT_VALUES)[number])) {
    errors.push({
      field: `${prefix}.cf_robots_variant`,
      message: `Unsupported value "${spec.cfRobotsVariant}"`,
      code: 'invalid_value',
    })
  }

  if (spec.advancedJson.trim()) {
    const parsed = parseJsonObject(spec.advancedJson)
    if (parsed.error) {
      errors.push({ field: `${prefix}.advanced_json`, message: `Advanced fields ${parsed.error}`, code: 'invalid_json' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
