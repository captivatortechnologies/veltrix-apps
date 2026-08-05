import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractTagSpecs, NAMED_COLORS } from './_shared'

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Validate tag items. Static — no target access required:
 *   - name and team_id are required
 *   - color must be one of the named palette values or a valid #RRGGBB hex
 *   - (team_id, name) must be unique across the canvas (its reconciliation identity)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractTagSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one tag.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Tag name is required.', code: 'EMPTY_NAME' })
    }
    if (!spec.teamId) {
      errors.push({ field: `${prefix}.team_id`, message: 'Team is required.', code: 'EMPTY_TEAM' })
    }
    if (!spec.color) {
      errors.push({ field: `${prefix}.color`, message: 'Color is required.', code: 'EMPTY_COLOR' })
    } else if (!(NAMED_COLORS as readonly string[]).includes(spec.color) && !HEX_COLOR_RE.test(spec.color)) {
      errors.push({
        field: `${prefix}.color`,
        message: `Color must be one of ${NAMED_COLORS.join(', ')}, or a #RRGGBB hex value (got "${spec.color}").`,
        code: 'INVALID_COLOR',
      })
    }

    if (spec.name && spec.teamId) {
      const key = `${spec.teamId}::${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.name`,
          message: `Tag "${spec.name}" is listed more than once for this team; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
