import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { GROUP_NAME_RE, checkXml } from './_shared'

/**
 * Validate agent-group items: a safe group name and — when a shared agent.conf is
 * supplied — a well-formed XML body. Static; no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one agent group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const groupName = String(item.fields.groupName ?? '').trim()
    const agentConf = String(item.fields.agentConf ?? '').trim()

    if (!groupName) {
      errors.push({ field: `items[${i}].groupName`, message: 'Group name is required.', code: 'EMPTY_NAME' })
    } else if (!GROUP_NAME_RE.test(groupName)) {
      errors.push({ field: `items[${i}].groupName`, message: `Group name "${groupName}" may only contain letters, numbers, dot, underscore or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(groupName)) {
      warnings.push({ field: `items[${i}].groupName`, message: `Group ${groupName} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(groupName)
    }

    if (!agentConf) {
      warnings.push({ field: `items[${i}].agentConf`, message: 'No shared agent.conf — the group will be created with no shared config.', code: 'NO_SHARED_CONF' })
    } else {
      const xml = checkXml(agentConf)
      if (!xml.valid) {
        warnings.push({ field: `items[${i}].agentConf`, message: `agent.conf may not be well-formed XML (${xml.reason}).`, code: 'MALFORMED_XML' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
