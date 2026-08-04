// Shared helpers for the Graylog Extractors config type (validate + deploy +
// rollback + drift). Shapes follow the Graylog REST API
// (/api/system/inputs/{inputId}/extractors):
//   • POST/PUT body  = CreateExtractorRequest { title, cursor_strategy, source_field,
//                       target_field, extractor_type, extractor_config, converters,
//                       condition_type, condition_value, order }
//   • GET  response  = ExtractorSummaryList { extractors: [ExtractorSummary] }
// Source: org.graylog2.rest.resources.system.inputs.ExtractorsResource (@ 6.1).
// An extractor's true identity is the PAIR (input, title) — Graylog assigns the
// id — so this config type reconciles by title WITHIN the input the item
// declares. Reuses the Inputs config type's list/find-by-title helpers to
// resolve `input_title` to an input id (the two types already share the same
// Graylog `title`-is-identity convention).

import { asString, toInt, parseJsonObject } from '../../lib/coerce'
import { inputsFromList, findInput } from '../inputs/_shared'

export { inputsFromList, findInput }

/** Graylog extractor `type` values (org.graylog2.plugin.inputs.Extractor.Type). */
export const EXTRACTOR_TYPES = new Set([
  'SUBSTRING',
  'REGEX',
  'REGEX_REPLACE',
  'SPLIT_AND_INDEX',
  'COPY_INPUT',
  'GROK',
  'JSON',
  'LOOKUP_TABLE',
])

/** Cursor strategies (Extractor.CursorStrategy): whether the source field is cut or copied. */
export const CURSOR_STRATEGIES = new Set(['CUT', 'COPY'])

/** Extractor run conditions (Extractor.ConditionType). */
export const CONDITION_TYPES = new Set(['NONE', 'STRING', 'REGEX'])

/** One extractor as returned by GET /api/system/inputs/{inputId}/extractors (ExtractorSummary). */
export interface GraylogExtractor {
  id?: string
  title?: string
  type?: string
  cursor_strategy?: string
  source_field?: string
  target_field?: string
  extractor_config?: Record<string, unknown>
  converters?: Array<Record<string, unknown>>
  condition_type?: string
  condition_value?: string
  order?: number
  [key: string]: unknown
}

/** GET .../extractors envelope: `{ extractors: [...], count }`. */
interface ExtractorListResponse {
  extractors?: GraylogExtractor[]
  count?: number
}

/** Body sent to POST/PUT .../extractors[/{extractorId}] (CreateExtractorRequest). */
export interface ExtractorBody {
  title: string
  cursor_strategy: string
  source_field: string
  target_field: string
  extractor_type: string
  extractor_config: Record<string, unknown>
  converters: Array<Record<string, unknown>>
  condition_type: string
  condition_value: string
  order: number
}

/** Unwrap GET .../extractors into a flat array of extractors. */
export function extractorsFromList(list: unknown): GraylogExtractor[] {
  if (Array.isArray(list)) return list as GraylogExtractor[]
  const extractors = (list as ExtractorListResponse | null)?.extractors
  return Array.isArray(extractors) ? extractors : []
}

/** Find a live extractor by title (the identity WITHIN one input's extractor list). */
export function findExtractor(extractors: GraylogExtractor[], title: string): GraylogExtractor | null {
  const t = asString(title)
  if (!t) return null
  return extractors.find((e) => asString(e.title) === t) ?? null
}

export interface BuiltExtractorBody {
  body?: ExtractorBody
  error?: string
}

/** Build the CreateExtractorRequest body from canvas fields. */
export function buildExtractorBody(fields: Record<string, unknown>): BuiltExtractorBody {
  const { value: extractorConfig, error: configError } = parseJsonObject(fields.extractor_config)
  if (configError) return { error: `extractor_config ${configError}` }

  const convertersRaw = fields.converters
  let converters: Array<Record<string, unknown>> = []
  if (convertersRaw != null && convertersRaw !== '') {
    try {
      const parsed = typeof convertersRaw === 'string' ? JSON.parse(convertersRaw) : convertersRaw
      if (!Array.isArray(parsed)) return { error: 'converters must be a JSON array' }
      converters = parsed as Array<Record<string, unknown>>
    } catch (e) {
      return { error: `converters is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
  }

  return {
    body: {
      title: asString(fields.title),
      cursor_strategy: asString(fields.cursor_strategy) || 'COPY',
      source_field: asString(fields.source_field) || 'message',
      target_field: asString(fields.target_field),
      extractor_type: asString(fields.extractor_type),
      extractor_config: extractorConfig,
      converters,
      condition_type: asString(fields.condition_type) || 'NONE',
      condition_value: asString(fields.condition_value),
      order: toInt(fields.order, 0),
    },
  }
}

/** Build a restore body from a live extractor (rollback). */
export function bodyFromLiveExtractor(extractor: GraylogExtractor): ExtractorBody {
  return {
    title: asString(extractor.title),
    cursor_strategy: asString(extractor.cursor_strategy) || 'COPY',
    source_field: asString(extractor.source_field) || 'message',
    target_field: asString(extractor.target_field),
    extractor_type: asString(extractor.type),
    extractor_config: (extractor.extractor_config && typeof extractor.extractor_config === 'object' ? extractor.extractor_config : {}) as Record<string, unknown>,
    converters: Array.isArray(extractor.converters) ? extractor.converters : [],
    condition_type: asString(extractor.condition_type) || 'NONE',
    condition_value: asString(extractor.condition_value),
    order: typeof extractor.order === 'number' ? extractor.order : 0,
  }
}
