import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractAll, extractElement, extractText, tag } from '../../lib/jamfClassicXml'

// =============================================================================
// Jamf Pro Smart Computer Groups — Classic API (XML).
//
// Smart computer groups are still Classic-API only:
// https://developer.jamf.com/jamf-pro/reference/findcomputergroups (list) and
// https://developer.jamf.com/jamf-pro/reference/findcomputergroupsbyid (full
// object), rooted at https://<host>/JSSResource. The modern Jamf Pro API only
// exposes a READ-only mirror (`GET /api/v2/computer-groups/smart-groups`, per
// the Classic docs' own "Jamf Pro API equivalent" note) — no create/update, so
// this config type manages the object through the Classic API end-to-end, via
// `JamfClient.classicRequest` (see lib/jamfApi.ts).
//
// A smart group's membership (`<computers>`) is entirely Jamf-computed from
// its `criteria` — this app never sends `<computers>`, and the `<site>`
// element (multi-site Jamf Pro tenants) is intentionally NOT a managed field:
// see the "not managed" note in `buildComputerGroupXml` below.
// =============================================================================

/** One smart-group criterion — the full field set Jamf Pro's Classic API documents (see findcomputergroupsbyid). */
export interface Criterion {
  name: string
  priority: number
  andOr: 'and' | 'or'
  searchType: string
  value: string
  openingParen: boolean
  closingParen: boolean
}

export interface SmartGroupSpec {
  sectionName: string
  name: string
  criteria: Criterion[]
}

/** Shape of a Jamf Pro computer_group object, parsed from Classic API XML. */
export interface LiveSmartGroup {
  id?: string
  name?: string
  isSmart?: boolean
  criteria: Criterion[]
}

/** The group's logical identity: its name (case-insensitive, trimmed). Jamf Pro does not enforce unique group names — see README. */
export function groupKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Index a list of `{id, name}` computer-group refs by name (case-insensitive; first match wins on a live duplicate). */
export function indexGroupsByName<T extends { name?: string }>(groups: T[]): Map<string, T> {
  const byName = new Map<string, T>()
  for (const group of groups) {
    if (!group.name) continue
    const key = groupKey(group.name)
    if (!byName.has(key)) byName.set(key, group)
  }
  return byName
}

/** Try to parse a criteria JSON blob into raw records; empty/blank text is an empty (ok) list. */
export function tryParseCriteriaJson(text: string): { value: unknown[] | null; ok: boolean } {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { value: [], ok: true }
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? { value: parsed, ok: true } : { value: null, ok: false }
  } catch {
    return { value: null, ok: false }
  }
}

/** Coerce one raw (already-JSON-parsed) criterion record into a `Criterion`, defaulting the optional fields. */
export function coerceCriterion(raw: unknown, index: number): Criterion {
  const r = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const bool = (v: unknown): boolean => v === true || v === 'true'
  return {
    name: str(r.name),
    priority: typeof r.priority === 'number' && Number.isFinite(r.priority) ? Math.trunc(r.priority) : index,
    andOr: str(r.andOr).toLowerCase() === 'or' ? 'or' : 'and',
    searchType: str(r.searchType),
    value: str(r.value),
    openingParen: bool(r.openingParen),
    closingParen: bool(r.closingParen),
  }
}

/** Each canvas item describes one Jamf Pro smart computer group. */
export function extractSmartGroupSpecs(canvas: CanvasSnapshot): SmartGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const parsed = tryParseCriteriaJson(typeof fields.criteria_json === 'string' ? fields.criteria_json : '')
    const criteria = (parsed.value ?? []).map((raw, i) => coerceCriterion(raw, i))
    return { sectionName: section.name, name: str(fields.name), criteria }
  })
}

// --- Classic XML build/parse ---------------------------------------------------

export function buildCriterionXml(c: Criterion): string {
  return (
    '<criterion>' +
    tag('name', c.name) +
    tag('priority', c.priority) +
    tag('and_or', c.andOr) +
    tag('search_type', c.searchType) +
    tag('value', c.value) +
    tag('opening_paren', c.openingParen) +
    tag('closing_paren', c.closingParen) +
    '</criterion>'
  )
}

/**
 * Build a full `<computer_group>` document for create/update. Intentionally
 * omits `<site>` (multi-site scoping) — not a field this config type manages.
 * On a plain update this means a group's Jamf Pro Site assignment reverts to
 * the tenant default; on a Veltrix ROLLBACK the exact prior raw XML is
 * restored byte-for-byte instead (see deploy.ts/rollback.ts), so Site is only
 * at risk between a deploy and its own rollback, not after one. Flagged as a
 * known limitation for multi-site tenants (see README) rather than silently
 * assumed safe.
 */
export function buildComputerGroupXml(spec: { name: string; criteria: Criterion[] }): string {
  const criteriaXml = spec.criteria.map(buildCriterionXml).join('')
  return `<computer_group>${tag('name', spec.name)}${tag('is_smart', true)}<criteria>${criteriaXml}</criteria></computer_group>`
}

export function parseCriterionXml(xml: string): Criterion {
  return {
    name: extractText(xml, 'name'),
    priority: Number(extractText(xml, 'priority')) || 0,
    andOr: extractText(xml, 'and_or').toLowerCase() === 'or' ? 'or' : 'and',
    searchType: extractText(xml, 'search_type'),
    value: extractText(xml, 'value'),
    openingParen: extractText(xml, 'opening_paren').toLowerCase() === 'true',
    closingParen: extractText(xml, 'closing_paren').toLowerCase() === 'true',
  }
}

/** Parse a full `<computer_group>…</computer_group>` document (from a Classic GET) into a `LiveSmartGroup`. */
export function parseComputerGroupXml(xml: string): LiveSmartGroup {
  const block = extractElement(xml, 'computer_group') ?? xml
  const id = extractText(block, 'id')
  const name = extractText(block, 'name')
  const isSmart = extractText(block, 'is_smart').toLowerCase() === 'true'
  const criteriaBlock = extractElement(block, 'criteria')
  const criteria = criteriaBlock ? extractAll(criteriaBlock, 'criterion').map(parseCriterionXml) : []
  return { id: id || undefined, name: name || undefined, isSmart, criteria }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate smart computer group configurations: a name is required and
 * unique across the canvas (case-insensitive); `criteria_json` must be valid
 * JSON array text; at least one criterion is required (an empty-criteria
 * smart group matches nothing meaningful); and every criterion needs a name,
 * search type and value, with `andOr` (when present) one of and/or.
 *
 * Criterion `name`/`searchType` are intentionally freeform text, not an
 * enumerated select — Jamf Pro's own UI offers a search-type list that
 * depends on which criterion (inventory attribute / extension attribute) is
 * chosen, and the Classic API exposes no endpoint to look that mapping up
 * generically. An invalid combination is caught by Jamf Pro itself at deploy
 * time and surfaced as a deploy error. Flagged, not faked.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const section of sections) {
    const fields = section.fields ?? {}
    const prefix = section.name
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    const criteriaJsonText = typeof fields.criteria_json === 'string' ? fields.criteria_json : ''

    if (!name) {
      errors.push({ field: `${prefix}.name`, message: 'Smart group name is required', code: 'required' })
    }

    const parsed = tryParseCriteriaJson(criteriaJsonText)
    if (!parsed.ok) {
      errors.push({
        field: `${prefix}.criteria_json`,
        message: 'Criteria must be valid JSON array text',
        code: 'invalid_json',
      })
    } else {
      const raw = parsed.value ?? []
      if (raw.length === 0) {
        errors.push({
          field: `${prefix}.criteria_json`,
          message: 'At least one criterion is required',
          code: 'required',
        })
      }
      raw.forEach((r, i) => {
        const c = coerceCriterion(r, i)
        if (!c.name) {
          errors.push({ field: `${prefix}.criteria_json[${i}].name`, message: 'Criterion name is required', code: 'required' })
        }
        if (!c.searchType) {
          errors.push({
            field: `${prefix}.criteria_json[${i}].searchType`,
            message: 'Criterion search type is required',
            code: 'required',
          })
        }
        const rawAndOr = r && typeof r === 'object' ? (r as Record<string, unknown>).andOr : undefined
        if (rawAndOr !== undefined && !['and', 'or'].includes(String(rawAndOr).toLowerCase())) {
          errors.push({
            field: `${prefix}.criteria_json[${i}].andOr`,
            message: `Unsupported andOr "${rawAndOr}" (must be "and" or "or")`,
            code: 'invalid_and_or',
          })
        }
      })
    }

    if (name) {
      const key = groupKey(name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate smart group "${name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_group',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
