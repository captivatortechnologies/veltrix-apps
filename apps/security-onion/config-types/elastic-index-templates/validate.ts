import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseStringList } from './_shared'

/**
 * Validate index template items: a safe template name, at least one index
 * pattern, positive shard/replica counts, and — when set — a safe ILM policy
 * name and composed-of list. Static — no target access required. Numbers may
 * arrive as number or string; coerce first.
 */
const NAME_RE = /^[a-zA-Z0-9._-]+$/
const PATTERN_RE = /^[a-zA-Z0-9*_.:-]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one index template.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const templateName = String(item.fields.templateName ?? '').trim()
    const indexPatterns = parseStringList(item.fields.indexPatterns)
    const composedOf = parseStringList(item.fields.composedOf)
    const numberOfShards = Number(item.fields.numberOfShards)
    const numberOfReplicas = Number(item.fields.numberOfReplicas)
    const priorityRaw = item.fields.priority
    const hasPriority = priorityRaw !== undefined && priorityRaw !== null && String(priorityRaw).trim() !== ''
    const priority = Number(priorityRaw)
    const ilmPolicyName = String(item.fields.ilmPolicyName ?? '').trim()

    if (!templateName) {
      errors.push({ field: `items[${i}].templateName`, message: 'Template name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(templateName)) {
      errors.push({ field: `items[${i}].templateName`, message: `Template name "${templateName}" may only contain letters, numbers, dot, underscore or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(templateName)) {
      warnings.push({ field: `items[${i}].templateName`, message: `Template ${templateName} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(templateName)
    }

    if (indexPatterns.length === 0) {
      errors.push({ field: `items[${i}].indexPatterns`, message: 'Add at least one index pattern (e.g. logs-custom-*).', code: 'EMPTY_PATTERNS' })
    } else {
      indexPatterns.forEach((p, j) => {
        if (!PATTERN_RE.test(p)) {
          errors.push({ field: `items[${i}].indexPatterns[${j}]`, message: `Index pattern "${p}" contains characters that are not valid in an Elasticsearch index pattern.`, code: 'INVALID_PATTERN' })
        }
      })
    }

    if (!Number.isFinite(numberOfShards) || numberOfShards < 1 || !Number.isInteger(numberOfShards)) {
      errors.push({ field: `items[${i}].numberOfShards`, message: 'Number of shards must be a positive integer.', code: 'INVALID_SHARDS' })
    }

    if (!Number.isFinite(numberOfReplicas) || numberOfReplicas < 0 || !Number.isInteger(numberOfReplicas)) {
      errors.push({ field: `items[${i}].numberOfReplicas`, message: 'Number of replicas must be a non-negative integer.', code: 'INVALID_REPLICAS' })
    }

    if (hasPriority && (!Number.isFinite(priority) || priority < 0 || !Number.isInteger(priority))) {
      errors.push({ field: `items[${i}].priority`, message: 'Priority must be a non-negative integer when set.', code: 'INVALID_PRIORITY' })
    }

    if (ilmPolicyName && !NAME_RE.test(ilmPolicyName)) {
      errors.push({ field: `items[${i}].ilmPolicyName`, message: `ILM policy name "${ilmPolicyName}" may only contain letters, numbers, dot, underscore or hyphen.`, code: 'INVALID_ILM_NAME' })
    }

    composedOf.forEach((c, j) => {
      if (!NAME_RE.test(c)) {
        errors.push({ field: `items[${i}].composedOf[${j}]`, message: `Component template name "${c}" may only contain letters, numbers, dot, underscore or hyphen.`, code: 'INVALID_COMPONENT_NAME' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
