import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseDeviceList } from './_shared'

const UUID_LIKE_RE = /^[0-9a-fA-F-]{8,64}$/

/**
 * Validate match-assignments items. Static — no target access required.
 *   - ruleset_uuid is required, loosely UUID-shaped, and doubles as the identity
 *     (duplicates warned).
 *   - at least one device serial is required; an empty list is allowed by the
 *     schema but warned since it declares "unassign every sensor from this
 *     ruleset" on deploy.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one ruleset assignment.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const uuid = String(item.fields.ruleset_uuid ?? '').trim()
    const devices = parseDeviceList(item.fields.device_serials)

    if (!uuid) {
      errors.push({ field: `items[${i}].ruleset_uuid`, message: 'Ruleset UUID is required.', code: 'EMPTY_UUID' })
    } else {
      if (!UUID_LIKE_RE.test(uuid)) {
        errors.push({ field: `items[${i}].ruleset_uuid`, message: `"${uuid}" does not look like a Vectra Match ruleset UUID.`, code: 'INVALID_UUID' })
      }
      if (seen.has(uuid)) {
        warnings.push({ field: `items[${i}].ruleset_uuid`, message: `Ruleset UUID "${uuid}" is listed more than once; the last one wins.`, code: 'DUPLICATE_UUID' })
      } else {
        seen.add(uuid)
      }
    }

    if (devices.length === 0) {
      warnings.push({
        field: `items[${i}].device_serials`,
        message: 'No sensor serials declared — deploying will unassign this ruleset from every currently-assigned sensor.',
        code: 'EMPTY_DEVICE_LIST',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
