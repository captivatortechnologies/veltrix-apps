import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractStorySettingsSpecs } from './_shared'

/**
 * Validate Story Settings items. Static — no target access required:
 *   - story_name is required (the story itself is verified to exist at deploy time)
 *   - keep_events_for_days, when set, must be between 1 and 365
 *   - (team_id, story_name) must be unique across the canvas
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractStorySettingsSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one story to configure.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.storyName) {
      errors.push({ field: `${prefix}.story_name`, message: 'Story is required.', code: 'EMPTY_STORY_NAME' })
    }
    if (spec.keepEventsForDays !== null && (spec.keepEventsForDays < 1 || spec.keepEventsForDays > 365)) {
      errors.push({
        field: `${prefix}.keep_events_for_days`,
        message: 'Keep Events For must be between 1 and 365 days.',
        code: 'INVALID_RETENTION',
      })
    }

    if (spec.storyName) {
      const key = `${spec.teamId}::${spec.storyName.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.story_name`,
          message: `Story "${spec.storyName}" is listed more than once for this team filter; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
