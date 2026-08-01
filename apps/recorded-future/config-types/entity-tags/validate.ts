import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  AVAILABLE_TAGS,
  MATCH_BY_VALUES,
  MAX_TAGS_PER_ENTITY,
  TAG_PATTERN,
  parseTags,
} from './_shared'

/**
 * Validate Entity Tagging items: a list name, an entity reference, a known
 * match-by mode and a well-formed tag set. Static — no target access required.
 *
 * The (list, entity) pair is the tagging identity, so a duplicate pair is warned
 * about (last one wins). Tags are enforced against the documented constraints:
 * at most 9 per entity (hard error), each tag well-formed (hard error), and each
 * tag part of the known Recorded Future vocabulary (advisory warning only, since
 * the vocabulary snapshot is best-effort and the API is the final authority). An
 * empty tag set is allowed but warned — deploy would CLEAR all tags on the entity.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Entity Tagging item.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const listName = String(item.fields.listName ?? '').trim()
    const entityRef = String(item.fields.entityRef ?? '').trim()
    const matchBy = String(item.fields.matchBy ?? 'id').trim()
    const tags = parseTags(item.fields.tags)

    if (!listName) {
      errors.push({ field: `items[${i}].listName`, message: 'List name is required.', code: 'EMPTY_LIST' })
    }

    if (!entityRef) {
      errors.push({ field: `items[${i}].entityRef`, message: 'Entity reference is required.', code: 'EMPTY_ENTITY' })
    } else if (listName) {
      const key = `${listName.toLowerCase()}::${entityRef.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].entityRef`,
          message: `Entity "${entityRef}" on list "${listName}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_TARGET',
        })
      } else {
        seen.add(key)
      }
    }

    if (!MATCH_BY_VALUES.has(matchBy as 'id' | 'name')) {
      errors.push({
        field: `items[${i}].matchBy`,
        message: `Match mode must be "id" or "name" (got "${matchBy}").`,
        code: 'INVALID_MATCH_BY',
      })
    }

    if (tags.length > MAX_TAGS_PER_ENTITY) {
      errors.push({
        field: `items[${i}].tags`,
        message: `An entity may have at most ${MAX_TAGS_PER_ENTITY} tags (got ${tags.length}).`,
        code: 'TOO_MANY_TAGS',
      })
    }

    for (const tag of tags) {
      if (!TAG_PATTERN.test(tag)) {
        errors.push({
          field: `items[${i}].tags`,
          message: `Tag "${tag}" is malformed — Recorded Future tags are lowercase letters, digits and underscores.`,
          code: 'INVALID_TAG_FORMAT',
        })
      } else if (!AVAILABLE_TAGS.has(tag)) {
        warnings.push({
          field: `items[${i}].tags`,
          message: `Tag "${tag}" is not in the known Recorded Future tag vocabulary — VERIFY it is accepted by your account.`,
          code: 'UNKNOWN_TAG',
        })
      }
    }

    if (tags.length === 0) {
      warnings.push({
        field: `items[${i}].tags`,
        message: `Entity "${entityRef || i}" has no tags — deploy will CLEAR all existing tags on it.`,
        code: 'NO_TAGS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
