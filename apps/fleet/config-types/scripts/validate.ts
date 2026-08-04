import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SCRIPT_TYPES } from './_shared'

/**
 * Validate script items: a safe name (no extension — deploy appends one), a
 * non-empty body under Fleet's 10,000-character ad hoc run-script limit, a
 * known script type and a numeric (or blank) team id. Static — no target
 * access required.
 */
const NAME_RE = /^[A-Za-z0-9_-]+$/
const TEAM_ID_RE = /^[0-9]*$/
const MAX_SCRIPT_CHARS = 9500

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one script.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const scriptType = String(item.fields.scriptType ?? 'sh').trim().toLowerCase()
    const scriptContent = String(item.fields.scriptContent ?? '')
    const teamId = String(item.fields.teamId ?? '').trim()
    const key = `${name}.${scriptType}`

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Name "${name}" may only contain letters, numbers, underscore or hyphen (no extension — it is appended automatically).`, code: 'INVALID_NAME' })
    } else if (seen.has(key)) {
      warnings.push({ field: `items[${i}].name`, message: `Script ${key} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(key)
    }

    if (!SCRIPT_TYPES.has(scriptType)) {
      errors.push({ field: `items[${i}].scriptType`, message: `Script Type must be one of sh, ps1 (got "${scriptType}").`, code: 'INVALID_SCRIPT_TYPE' })
    }

    if (!scriptContent.trim()) {
      errors.push({ field: `items[${i}].scriptContent`, message: 'Script Content is required.', code: 'EMPTY_CONTENT' })
    } else if (scriptContent.length > MAX_SCRIPT_CHARS) {
      errors.push({
        field: `items[${i}].scriptContent`,
        message: `Script Content is ${scriptContent.length} characters; Fleet's upload limit is 10,000.`,
        code: 'CONTENT_TOO_LARGE',
      })
    }

    if (!TEAM_ID_RE.test(teamId)) {
      errors.push({ field: `items[${i}].teamId`, message: 'Team ID must be numeric, or blank for "Unassigned".', code: 'INVALID_TEAM_ID' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
