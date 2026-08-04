import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'
import { parseSidecarTags } from './_shared'

/** Sidecar rejects configuration names containing shell/path-hostile characters (it becomes a filename). */
const INVALID_NAME_CHARS = /[;*?"<>|&]/

/**
 * Validate sidecar-configuration items: a non-empty name free of
 * path/shell-hostile characters (the identity — a duplicate is flagged, last
 * one wins), a non-empty collector_name (resolved to a collector id at deploy
 * time — see the "Sidecar Collectors" configuration type), and a non-empty
 * template. Static — no target access, so an unresolvable collector name
 * surfaces as a deploy-time error.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one sidecar configuration.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = asString(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Configuration name is required.', code: 'EMPTY_NAME' })
    } else if (INVALID_NAME_CHARS.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Configuration name "${name}" cannot contain any of ; * ? " < > | &.`, code: 'INVALID_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Configuration name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!asString(item.fields.collector_name)) {
      errors.push({ field: `items[${i}].collector_name`, message: 'Collector name is required.', code: 'EMPTY_COLLECTOR_NAME' })
    }

    if (!String(item.fields.template ?? '').trim()) {
      errors.push({ field: `items[${i}].template`, message: 'Template is required.', code: 'EMPTY_TEMPLATE' })
    }

    const { error } = parseSidecarTags(item.fields.tags)
    if (error) {
      errors.push({ field: `items[${i}].tags`, message: error, code: 'INVALID_TAGS_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
