import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidJsonField, isValidRefreshInterval, normalizeBool } from './_shared'

/**
 * Validate dashboard items: a non-empty title, well-formed JSON for the
 * time-range/panels/layout/variables blobs, and a recognized refresh interval.
 * Static — no target access required. A duplicate (folderId, title) pair is
 * flagged, since dashboard titles are only meaningfully unique within a folder.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one dashboard.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = String(item.fields.title ?? '').trim()
    const folderId = String(item.fields.folderId ?? '').trim()

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Dashboard title is required.', code: 'EMPTY_TITLE' })
    } else {
      const key = `${folderId.toLowerCase()}::${title.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].title`,
          message: `Dashboard "${title}" is listed more than once for the same folder; the last one wins.`,
          code: 'DUPLICATE_TITLE',
        })
      } else {
        seen.add(key)
      }
    }

    if (!isValidJsonField(item.fields.timeRange)) {
      errors.push({ field: `items[${i}].timeRange`, message: 'Time range must be well-formed JSON.', code: 'INVALID_TIME_RANGE_JSON' })
    }
    if (!isValidJsonField(item.fields.panels)) {
      errors.push({ field: `items[${i}].panels`, message: 'Panels must be well-formed JSON.', code: 'INVALID_PANELS_JSON' })
    }
    if (!isValidJsonField(item.fields.layout)) {
      errors.push({ field: `items[${i}].layout`, message: 'Layout must be well-formed JSON.', code: 'INVALID_LAYOUT_JSON' })
    }
    if (!isValidJsonField(item.fields.variables)) {
      errors.push({ field: `items[${i}].variables`, message: 'Variables must be well-formed JSON.', code: 'INVALID_VARIABLES_JSON' })
    }

    if (!isValidRefreshInterval(item.fields.refreshInterval)) {
      errors.push({
        field: `items[${i}].refreshInterval`,
        message: 'Refresh interval must be one of: 0, 30, 60, 120, 300, 900, 1800, 3600, 7200, 86400 seconds.',
        code: 'INVALID_REFRESH_INTERVAL',
      })
    }

    if (normalizeBool(item.fields.isPublic)) {
      warnings.push({
        field: `items[${i}].isPublic`,
        message: `Dashboard "${title || i}" is public — anyone with its link can view it without a Sumo Logic account.`,
        code: 'PUBLIC_DASHBOARD',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
