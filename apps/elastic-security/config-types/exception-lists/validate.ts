import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Kibana Exceptions API constraints ---------------------------------------

/** List name / list_id length caps (Kibana console limits). */
export const MAX_LIST_ID_LENGTH = 255
export const MAX_LIST_NAME_LENGTH = 255
export const MAX_LIST_DESCRIPTION_LENGTH = 1000

/** Valid exception-list container types. */
export const ALLOWED_LIST_TYPES = [
  'detection',
  'rule_default',
  'endpoint',
  'endpoint_events',
  'endpoint_host_isolation_exceptions',
  'endpoint_blocklists',
] as const

/** Valid namespace types. */
export const ALLOWED_NAMESPACE_TYPES = ['single', 'agnostic'] as const

/** The endpoint_* family is created/managed by the Elastic Defend integration. */
export function isEndpointType(type: string): boolean {
  return type.startsWith('endpoint')
}

/** Server-managed fields Kibana injects onto a list/item — never authored, never sent. */
export const SERVER_MANAGED_FIELDS = [
  'id',
  'tie_breaker_id',
  '_version',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ExceptionListSpec {
  sectionName: string
  /** list_id — the logical identity we match live lists on. */
  listId: string
  name: string
  description?: string
  /** Container type (detection | rule_default | endpoint_*). Default "detection". */
  type: string
  /** single | agnostic. Default "single". Endpoint artifacts must be agnostic. */
  namespaceType: string
  /** Raw JSON-array string of exception items; absent/blank = a list with no items. */
  itemsJson?: string
}

/** Shape of an exception list returned by GET /api/exception_lists. */
export interface LiveExceptionList {
  id?: string
  list_id?: string
  name?: string
  description?: string
  type?: string
  namespace_type?: string
}

/** Shape of an exception item returned by GET /api/exception_lists/items/_find. */
export interface LiveExceptionItem {
  id?: string
  item_id?: string
  list_id?: string
  name?: string
  type?: string
  namespace_type?: string
  entries?: unknown[]
  [key: string]: unknown
}

/** Each canvas item describes one exception list (container + folded-in items). */
export function extractListSpecs(canvas: CanvasSnapshot): ExceptionListSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const itemsJson =
      typeof fields.itemsJson === 'string' && fields.itemsJson.trim()
        ? fields.itemsJson.trim()
        : undefined
    const type =
      typeof fields.type === 'string' && fields.type.trim() ? fields.type.trim() : 'detection'
    const namespaceType =
      typeof fields.namespaceType === 'string' && fields.namespaceType.trim()
        ? fields.namespaceType.trim()
        : 'single'

    return {
      sectionName: section.name,
      listId: typeof fields.list_id === 'string' ? fields.list_id.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      type,
      namespaceType,
      itemsJson,
    }
  })
}

/**
 * Parse a raw itemsJson string, returning the item array or null when the string
 * is not a JSON ARRAY (a JSON object or primitive counts as invalid). Shared by
 * validate (to reject bad input) and deploy (to build the item bodies).
 */
export function parseItemsArray(raw: string): Record<string, unknown>[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) {
    return parsed as Record<string, unknown>[]
  }
  return null
}

/** A single item's item_id, or '' when it is absent / not a string. */
export function itemIdOf(item: unknown): string {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const id = (item as Record<string, unknown>).item_id
    return typeof id === 'string' ? id.trim() : ''
  }
  return ''
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate exception-list configurations against Kibana Exceptions API
 * constraints. Static rules only — NO network:
 *   - list_id + name are required; list_id is the logical identity and must be
 *     unique across the canvas.
 *   - type must be a known list type; namespace must be single | agnostic.
 *   - itemsJson (when present) must parse to a JSON ARRAY; each item needs an
 *     item_id, a name and an entries array, and item_id must be unique per list.
 *   - endpoint_* list types are WARNED (integration-managed), and endpoint
 *     artifacts are warned when their namespace is not "agnostic".
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

    // list_id — required, capped, and the logical identity
    if (!spec.listId) {
      errors.push({ field: `${prefix}.list_id`, message: 'List ID is required', code: 'required' })
    } else if (spec.listId.length > MAX_LIST_ID_LENGTH) {
      errors.push({
        field: `${prefix}.list_id`,
        message: `List ID must be ${MAX_LIST_ID_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // name — required, capped
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'List name is required', code: 'required' })
    } else if (spec.name.length > MAX_LIST_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `List name must be ${MAX_LIST_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // description — optional, capped
    if (spec.description && spec.description.length > MAX_LIST_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_LIST_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // type — must be a known container type
    if (!ALLOWED_LIST_TYPES.includes(spec.type as (typeof ALLOWED_LIST_TYPES)[number])) {
      errors.push({
        field: `${prefix}.type`,
        message: `List type must be one of: ${ALLOWED_LIST_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    } else if (isEndpointType(spec.type)) {
      // Endpoint lists are integration-managed — warn rather than reject so a
      // user who deliberately authors one can, but knows it is unusual.
      warnings.push({
        field: `${prefix}.type`,
        message: `List type "${spec.type}" is normally created and managed by the Elastic Defend integration — authoring it as code may conflict with the integration`,
        code: 'endpoint_managed',
      })
      // Endpoint artifacts must live in the agnostic namespace.
      if (spec.namespaceType !== 'agnostic') {
        warnings.push({
          field: `${prefix}.namespaceType`,
          message: `Endpoint list types require the "agnostic" namespace — "${spec.namespaceType}" will be rejected by Kibana for endpoint artifacts`,
          code: 'endpoint_namespace',
        })
      }
    }

    // namespace — single | agnostic
    if (!ALLOWED_NAMESPACE_TYPES.includes(spec.namespaceType as (typeof ALLOWED_NAMESPACE_TYPES)[number])) {
      errors.push({
        field: `${prefix}.namespaceType`,
        message: `Namespace must be one of: ${ALLOWED_NAMESPACE_TYPES.join(', ')}`,
        code: 'invalid_namespace',
      })
    }

    // itemsJson — optional; when present it must parse to a JSON ARRAY, and each
    // item needs item_id / name / entries, with item_id unique within the list.
    if (spec.itemsJson) {
      const items = parseItemsArray(spec.itemsJson)
      if (items === null) {
        errors.push({
          field: `${prefix}.itemsJson`,
          message:
            'Items must be a valid JSON array, e.g. [{"item_id":"…","name":"…","entries":[…]}] — leave blank for a list with no items',
          code: 'invalid_items',
        })
      } else {
        const seenItemIds = new Set<string>()
        items.forEach((item, index) => {
          const itemPrefix = `${prefix}.itemsJson[${index}]`
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            errors.push({
              field: itemPrefix,
              message: 'Each exception item must be a JSON object',
              code: 'invalid_item',
            })
            return
          }
          const rec = item as Record<string, unknown>

          const itemId = typeof rec.item_id === 'string' ? rec.item_id.trim() : ''
          if (!itemId) {
            errors.push({
              field: `${itemPrefix}.item_id`,
              message: 'Each exception item requires an item_id (its stable key)',
              code: 'item_missing_id',
            })
          } else {
            if (seenItemIds.has(itemId)) {
              errors.push({
                field: `${itemPrefix}.item_id`,
                message: `Duplicate item_id "${itemId}" — each item_id may only appear once within a list`,
                code: 'duplicate_item',
              })
            }
            seenItemIds.add(itemId)
          }

          if (typeof rec.name !== 'string' || !rec.name.trim()) {
            errors.push({
              field: `${itemPrefix}.name`,
              message: 'Each exception item requires a name',
              code: 'item_missing_name',
            })
          }

          if (!Array.isArray(rec.entries)) {
            errors.push({
              field: `${itemPrefix}.entries`,
              message: 'Each exception item requires an "entries" array of match conditions',
              code: 'item_missing_entries',
            })
          } else if (rec.entries.length === 0) {
            warnings.push({
              field: `${itemPrefix}.entries`,
              message: 'Exception item has an empty "entries" array — it will match nothing',
              code: 'empty_entries',
            })
          }
        })
      }
    }

    // list_id is the logical identity — dedupe on it (case-sensitive, matching
    // the name-based live lookup in deploy / drift).
    if (spec.listId) {
      if (seenListIds.has(spec.listId)) {
        errors.push({
          field: `${prefix}.list_id`,
          message: `Duplicate list "${spec.listId}" — each list_id may only be declared once per canvas`,
          code: 'duplicate_list',
        })
      }
      seenListIds.add(spec.listId)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
