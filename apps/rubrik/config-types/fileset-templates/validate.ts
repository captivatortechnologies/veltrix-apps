import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeName, normalizeOsType, toBool, toStringArray } from './_shared'

/**
 * Validate Fileset Template items: a non-empty, unique name and at least one
 * include path (Rubrik rejects a template with no includes). Static — no target
 * access required. The name is the template's identity, so a duplicate name is an
 * error (Rubrik would collide on create).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one fileset template.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = normalizeName(item.fields.name)
    const os = normalizeOsType(item.fields.operatingSystemType)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Fileset template name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      errors.push({ field: `items[${i}].name`, message: `Fileset template name "${name}" is listed more than once.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    const includes = toStringArray(item.fields.includes)
    if (includes.length === 0) {
      errors.push({
        field: `items[${i}].includes`,
        message: `Fileset template "${name || i}" has no include paths — add at least one path to back up.`,
        code: 'NO_INCLUDES',
      })
    }

    // useWindowsVss only applies to Windows hosts; flag it on a Linux template so
    // it isn't silently dropped.
    if (os === 'Linux' && toBool(item.fields.useWindowsVss)) {
      warnings.push({
        field: `items[${i}].useWindowsVss`,
        message: 'Windows VSS is set on a Linux template — it will be ignored. Clear it or switch the OS type to Windows.',
        code: 'VSS_ON_LINUX',
      })
    }

    // An exception re-includes something an exclude would drop; it is meaningless
    // without any excludes.
    const excludes = toStringArray(item.fields.excludes)
    const exceptions = toStringArray(item.fields.exceptions)
    if (exceptions.length > 0 && excludes.length === 0) {
      warnings.push({
        field: `items[${i}].exceptions`,
        message: 'Exception paths are set but there are no exclude paths — exceptions only re-include paths an exclude removed, so they will have no effect.',
        code: 'EXCEPTIONS_WITHOUT_EXCLUDES',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
