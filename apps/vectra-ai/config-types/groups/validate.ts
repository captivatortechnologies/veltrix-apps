import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { GROUP_TYPES, parseList } from './_shared'

/**
 * Validate group items. Static — no target access required.
 *   - name is required and doubles as the group identity (duplicates warned).
 *   - type must be one of host / ip / domain / account.
 *   - a group should carry at least one member (empty groups are warned, not blocked
 *     — Vectra accepts an empty group and members can be added later).
 *   - members are shape-checked against the group type: host members must be numeric
 *     host IDs; ip members must be valid IPv4 addresses or CIDR ranges.
 */
const IP_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/

function isIpOrCidr(value: string): boolean {
  const m = IP_CIDR_RE.exec(value)
  if (!m) return false
  if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return false
  if (m[5] && Number(m[5].slice(1)) > 32) return false
  return true
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = item.fields
    const name = String(f.name ?? '').trim()
    const type = String(f.type ?? '').trim()
    const members = parseList(f.members)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Group name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Group name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: 'Group type is required.', code: 'EMPTY_TYPE' })
    } else if (!GROUP_TYPES.has(type)) {
      errors.push({ field: `items[${i}].type`, message: `Group type "${type}" is not one of ${[...GROUP_TYPES].join(', ')}.`, code: 'INVALID_TYPE' })
    }

    if (members.length === 0) {
      warnings.push({ field: `items[${i}].members`, message: 'Group has no members — it will be created empty.', code: 'EMPTY_MEMBERS' })
    }

    if (type === 'host') {
      members.forEach((m) => {
        if (!Number.isFinite(Number(m))) {
          errors.push({ field: `items[${i}].members`, message: `Host group member "${m}" is not a numeric host ID.`, code: 'NON_NUMERIC_MEMBER' })
        }
      })
    }
    if (type === 'ip') {
      members.forEach((m) => {
        if (!isIpOrCidr(m)) {
          errors.push({ field: `items[${i}].members`, message: `IP group member "${m}" is not a valid IPv4 address or CIDR range.`, code: 'INVALID_IP_MEMBER' })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
