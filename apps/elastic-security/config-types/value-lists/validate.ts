import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Kibana Lists API constraints (/api/lists, /api/lists/items) ------------

export const MAX_LIST_ID_LENGTH = 255
export const MAX_LIST_NAME_LENGTH = 255
export const MAX_LIST_DESCRIPTION_LENGTH = 1000

/** Value types the Lists API accepts for `type` (create_list_schema `type` enum). */
export const ALLOWED_VALUE_TYPES = [
  'boolean',
  'byte',
  'date',
  'date_nanos',
  'date_range',
  'double',
  'double_range',
  'float',
  'float_range',
  'half_float',
  'integer',
  'integer_range',
  'ip',
  'ip_range',
  'keyword',
  'long',
  'long_range',
  'short',
  'text',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ValueListSpec {
  sectionName: string
  /** List id — the logical identity we match live lists on. */
  id: string
  name: string
  description?: string
  /** The Elasticsearch field type every item's value is stored as. IMMUTABLE after creation. */
  type: string
  /** Raw JSON-array string of value items; absent/blank = a list with no items. */
  itemsJson?: string
}

/** Shape of a value list returned by GET /api/lists (list container fields this app authors/diffs). */
export interface LiveValueList {
  id?: string
  name?: string
  description?: string
  type?: string
  created_at?: string
  created_by?: string
  updated_at?: string
  updated_by?: string
}

/** Shape of a value-list item returned by GET /api/lists/items/_find. */
export interface LiveValueListItem {
  id?: string
  list_id?: string
  value?: unknown
  [key: string]: unknown
}

/** Each canvas item describes one value list (container + folded-in items). */
export function extractListSpecs(canvas: CanvasSnapshot): ValueListSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim() ? fields.description.trim() : undefined
    const itemsJson =
      typeof fields.itemsJson === 'string' && fields.itemsJson.trim() ? fields.itemsJson.trim() : undefined
    const type = typeof fields.type === 'string' && fields.type.trim() ? fields.type.trim() : 'keyword'

    return {
      sectionName: section.name,
      id: typeof fields.id === 'string' ? fields.id.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      type,
      itemsJson,
    }
  })
}

/**
 * Parse a raw itemsJson string, returning the item array or null when the
 * string is not a JSON ARRAY. Shared by validate (to reject bad input) and
 * deploy (to build the item bodies).
 */
export function parseItemsArray(raw: string): Record<string, unknown>[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null
}

/** A single item's id, or '' when it is absent / not a string. */
export function itemIdOf(item: unknown): string {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const id = (item as Record<string, unknown>).id
    return typeof id === 'string' ? id.trim() : ''
  }
  return ''
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate value-list configurations against the Kibana Lists API. Static
 * rules only — NO network:
 *   - id + name are required; id is the logical identity and must be unique
 *     across the canvas.
 *   - type must be a value type the Lists API recognises.
 *   - itemsJson (when present) must parse to a JSON ARRAY; each item needs an
 *     id and a value, and id must be unique per list. The item VALUE's shape is
 *     NOT deep-validated against its type (e.g. a range's "start-end" form) —
 *     Kibana validates it at deploy time, the same pass-through treatment
 *     exception-lists gives its entries.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractListSpecs(ctx.canvas)
  const seenListIds = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'List ID is required', code: 'required' })
    } else if (spec.id.length > MAX_LIST_ID_LENGTH) {
      errors.push({
        field: `${prefix}.id`,
        message: `List ID must be ${MAX_LIST_ID_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'List name is required', code: 'required' })
    } else if (spec.name.length > MAX_LIST_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `List name must be ${MAX_LIST_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (spec.description && spec.description.length > MAX_LIST_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_LIST_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (!ALLOWED_VALUE_TYPES.includes(spec.type as (typeof ALLOWED_VALUE_TYPES)[number])) {
      errors.push({
        field: `${prefix}.type`,
        message: `Value Type must be one of: ${ALLOWED_VALUE_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    if (spec.itemsJson) {
      const items = parseItemsArray(spec.itemsJson)
      if (items === null) {
        errors.push({
          field: `${prefix}.itemsJson`,
          message: 'Items must be a valid JSON array, e.g. [{"id":"…","value":"…"}] — leave blank for a list with no items',
          code: 'invalid_items',
        })
      } else {
        const seenItemIds = new Set<string>()
        items.forEach((item, index) => {
          const itemPrefix = `${prefix}.itemsJson[${index}]`
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            errors.push({ field: itemPrefix, message: 'Each value-list item must be a JSON object', code: 'invalid_item' })
            return
          }
          const rec = item as Record<string, unknown>

          const itemId = typeof rec.id === 'string' ? rec.id.trim() : ''
          if (!itemId) {
            errors.push({
              field: `${itemPrefix}.id`,
              message: 'Each value-list item requires an id (its stable key)',
              code: 'item_missing_id',
            })
          } else {
            if (seenItemIds.has(itemId)) {
              errors.push({
                field: `${itemPrefix}.id`,
                message: `Duplicate item id "${itemId}" — each item id may only appear once within a list`,
                code: 'duplicate_item',
              })
            }
            seenItemIds.add(itemId)
          }

          if (rec.value === undefined || rec.value === null || rec.value === '') {
            errors.push({
              field: `${itemPrefix}.value`,
              message: 'Each value-list item requires a "value" matching the list\'s Value Type',
              code: 'item_missing_value',
            })
          }
        })
      }
    }

    if (spec.id) {
      if (seenListIds.has(spec.id)) {
        errors.push({
          field: `${prefix}.id`,
          message: `Duplicate list "${spec.id}" — each list id may only be declared once per canvas`,
          code: 'duplicate_list',
        })
      }
      seenListIds.add(spec.id)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
