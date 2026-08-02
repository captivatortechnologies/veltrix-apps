import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { UUID_RE, splitHosts } from './_shared'

/**
 * Validate scan-target items: a non-empty name, at least one host token, and a
 * UUID-shaped port list id. Static — no gvmd access required. Target names double
 * as the upsert identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scan target.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const hosts = splitHosts(item.fields.hosts)
    const portListId = String(item.fields.portListId ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Target name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Target name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (hosts.length === 0) {
      errors.push({ field: `items[${i}].hosts`, message: 'At least one host (CIDR, IP or hostname) is required.', code: 'EMPTY_HOSTS' })
    }

    if (!portListId) {
      errors.push({ field: `items[${i}].portListId`, message: 'A port list is required.', code: 'EMPTY_PORT_LIST' })
    } else if (!UUID_RE.test(portListId)) {
      errors.push({ field: `items[${i}].portListId`, message: `Port list "${portListId}" must be a GMP port_list UUID.`, code: 'INVALID_PORT_LIST' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
