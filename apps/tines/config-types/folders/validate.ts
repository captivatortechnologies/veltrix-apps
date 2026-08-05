import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractFolderSpecs, CONTENT_TYPES } from './_shared'

/**
 * Validate folder items. Static — no target access required:
 *   - name, team_id and content_type are required
 *   - content_type must be one of STORY / CREDENTIAL / RESOURCE
 *   - (team_id, content_type, parent_folder_name, name) must be unique across the canvas
 *   - a folder cannot declare itself as its own parent
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractFolderSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one folder.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Folder name is required.', code: 'EMPTY_NAME' })
    }
    if (!spec.teamId) {
      errors.push({ field: `${prefix}.team_id`, message: 'Team is required.', code: 'EMPTY_TEAM' })
    }
    if (!spec.contentType) {
      errors.push({ field: `${prefix}.content_type`, message: 'Content type is required.', code: 'EMPTY_CONTENT_TYPE' })
    } else if (!(CONTENT_TYPES as readonly string[]).includes(spec.contentType)) {
      errors.push({
        field: `${prefix}.content_type`,
        message: `Content type "${spec.contentType}" must be one of: ${CONTENT_TYPES.join(', ')}.`,
        code: 'INVALID_CONTENT_TYPE',
      })
    }
    if (spec.parentFolderName && spec.name && spec.parentFolderName.toLowerCase() === spec.name.toLowerCase()) {
      errors.push({
        field: `${prefix}.parent_folder_name`,
        message: 'A folder cannot be its own parent.',
        code: 'SELF_PARENT',
      })
    }

    if (spec.name && spec.teamId && spec.contentType) {
      const key = `${spec.teamId}::${spec.contentType}::${spec.parentFolderName.toLowerCase()}::${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.name`,
          message: `Folder "${spec.name}" is listed more than once for this team/content type/parent; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
