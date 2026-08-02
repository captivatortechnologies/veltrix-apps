import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeName, toInt } from './_shared'

/**
 * Validate Managed Volume items: a non-empty, unique name and a positive channel
 * count and volume size (Rubrik provisions real storage, so both must be set).
 * Static — no target access required. The name is the MV's identity, so a
 * duplicate name is an error (Rubrik would collide on create).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one managed volume.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = normalizeName(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Managed volume name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      errors.push({ field: `items[${i}].name`, message: `Managed volume name "${name}" is listed more than once.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    const channels = toInt(item.fields.numChannels)
    if (channels <= 0) {
      errors.push({
        field: `items[${i}].numChannels`,
        message: `Managed volume "${name || i}" needs at least one channel.`,
        code: 'NO_CHANNELS',
      })
    }

    const sizeGb = toInt(item.fields.volumeSizeGb)
    if (sizeGb <= 0) {
      errors.push({
        field: `items[${i}].volumeSizeGb`,
        message: `Managed volume "${name || i}" needs a volume size greater than 0 GiB.`,
        code: 'NO_SIZE',
      })
    }

    // A high channel count with no host patterns still works (any host may mount),
    // but is worth flagging so an export scope isn't forgotten.
    if (channels > 8) {
      warnings.push({
        field: `items[${i}].numChannels`,
        message: `Managed volume "${name || i}" requests ${channels} channels — high channel counts consume more host mount points; confirm this is intended.`,
        code: 'HIGH_CHANNELS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
