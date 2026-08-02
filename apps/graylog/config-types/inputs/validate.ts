import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString, toBool, parseJsonObject } from '../../lib/coerce'

/**
 * Validate input items: a non-empty title (the identity, so a duplicate is
 * flagged — last one wins), a non-empty type (Graylog expects the fully-qualified
 * input class, e.g. org.graylog2.inputs.gelf.udp.GELFUDPInput), and a well-formed
 * configuration JSON object. Static — no target access, so per-type required
 * configuration keys (bind_address, port, ...) surface at deploy time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one input.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = asString(item.fields.title)
    const type = asString(item.fields.type)

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Input title is required.', code: 'EMPTY_TITLE' })
    } else if (seen.has(title)) {
      warnings.push({ field: `items[${i}].title`, message: `Input title "${title}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TITLE' })
    } else {
      seen.add(title)
    }

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: 'Input type is required (the fully-qualified Graylog input class).', code: 'EMPTY_TYPE' })
    } else if (!type.includes('.')) {
      warnings.push({ field: `items[${i}].type`, message: `Input type "${type}" is not a fully-qualified class (expected e.g. org.graylog2.inputs.gelf.udp.GELFUDPInput).`, code: 'SUSPICIOUS_TYPE' })
    }

    const { value: configuration, error } = parseJsonObject(item.fields.configuration)
    if (error) {
      errors.push({ field: `items[${i}].configuration`, message: `configuration ${error}`, code: 'INVALID_CONFIG_JSON' })
    } else if (Object.keys(configuration).length === 0) {
      warnings.push({ field: `items[${i}].configuration`, message: 'configuration is empty — most inputs require keys such as bind_address and port.', code: 'EMPTY_CONFIG' })
    }

    // A non-global (node-local) input needs a node id; Graylog rejects the create
    // otherwise. Default to global so a node is not required.
    if (!toBool(item.fields.global) && !asString(item.fields.node)) {
      warnings.push({ field: `items[${i}].node`, message: 'A non-global input needs a "node" id (or set it global).', code: 'NON_GLOBAL_NEEDS_NODE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
