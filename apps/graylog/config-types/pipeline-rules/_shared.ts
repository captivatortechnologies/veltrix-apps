// Shared helpers for the Graylog Pipeline Rules config type (validate + deploy +
// rollback + drift). Shapes follow the Graylog REST API (/api/system/pipelines/rule):
//   • POST/PUT body  = RuleSource { source (required), description?, title? }
//   • GET  response  = bare JSON array of RuleSource
// IMPORTANT: on create/update Graylog IGNORES the body `title` and derives the
// rule's title from the DSL rule name (`.title(rule.name())` in RuleResource.java
// @ 6.1). The identity `title` therefore MUST equal the `rule "NAME"` in the
// source, which validate.ts enforces.
// The pipeline processor is bundled as a SYSTEM plugin (addSystemRestResource), so
// its resources are served under core /api — hence /api/system/pipelines/rule
// (older external plugin builds used /api/plugins/org.graylog.plugins.pipelineprocessor/...).

import { asString } from '../../lib/coerce'

/** One pipeline rule as returned by GET /api/system/pipelines/rule (RuleSource). */
export interface GraylogPipelineRule {
  id?: string
  title?: string
  description?: string
  source?: string
  created_at?: string
  modified_at?: string
  errors?: unknown
  [key: string]: unknown
}

/** Body sent to POST/PUT /api/system/pipelines/rule. */
export interface RuleBody {
  title: string
  description: string
  source: string
}

/** GET /api/system/pipelines/rule returns a bare JSON array of RuleSource. */
export function rulesFromList(list: unknown): GraylogPipelineRule[] {
  return Array.isArray(list) ? (list as GraylogPipelineRule[]) : []
}

/** Find a live rule by title (the stable identity used for upsert + drift). */
export function findRule(rules: GraylogPipelineRule[], title: string): GraylogPipelineRule | null {
  const t = asString(title)
  if (!t) return null
  return rules.find((r) => asString(r.title) === t) ?? null
}

/**
 * Extract the rule name from a Graylog pipeline rule DSL source: `rule "NAME"`.
 * Returns null when no rule declaration is present. Unescapes \" / \\ in the name.
 */
export function extractRuleName(source: unknown): string | null {
  const m = String(source ?? '').match(/\brule\s+"((?:[^"\\]|\\.)*)"/)
  return m ? m[1].replace(/\\(["\\])/g, '$1') : null
}

/** Build the RuleSource body from canvas fields. */
export function buildRuleBody(fields: Record<string, unknown>): RuleBody {
  return {
    title: asString(fields.title),
    description: asString(fields.description),
    source: String(fields.source ?? '').trim(),
  }
}

/** Build a restore body from a live rule (rollback). */
export function bodyFromLiveRule(rule: GraylogPipelineRule): RuleBody {
  return {
    title: asString(rule.title),
    description: asString(rule.description),
    source: String(rule.source ?? '').trim(),
  }
}

/** Collapse runs of whitespace so cosmetic reformatting isn't read as drift. */
export function normalizeSource(source: unknown): string {
  return String(source ?? '').replace(/\s+/g, ' ').trim()
}
