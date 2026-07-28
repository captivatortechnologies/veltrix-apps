import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Workbooks are Azure Monitor workbooks (Microsoft.Insights/workbooks) scoped to
 * the Sentinel workspace, NOT Microsoft.SecurityInsights resources — so they use
 * their own api-version and category. Pinned to the GA 2023-06-01 release.
 */
export const WORKBOOKS_API_VERSION = '2023-06-01'
/** The Sentinel workbook gallery category — how Sentinel workbooks are listed/filtered. */
export const WORKBOOK_CATEGORY = 'sentinel'
/** The only valid workbook kind (Microsoft.Insights WorkbookSharedTypeKind enum). */
export const WORKBOOK_KIND = 'shared'
/** serializedData schema version that pairs with the workbook JSON. */
export const WORKBOOK_VERSION = 'Notebook/1.0'

/** One workbook authored on the canvas. */
export interface WorkbookSpec {
  sectionName: string
  /** The workbook display name — the reconciliation identity (its ARM name is a server GUID). */
  displayName: string
  /** The entire workbook definition JSON, stored verbatim as the ARM serializedData string. */
  serializedData: string
}

/** The reconciliation key is the display name (trimmed + lower-cased for matching). */
export function workbookKey(displayName: string): string {
  return displayName.trim().toLowerCase()
}

/** True when a string parses as JSON (workbook serializedData must be valid JSON). */
export function isJsonParseable(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

/** Each canvas item is one workbook. */
export function extractWorkbookSpecs(canvas: CanvasSnapshot): WorkbookSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      displayName: typeof fields.display_name === 'string' ? fields.display_name.trim() : '',
      serializedData: typeof fields.serialized_data === 'string' ? fields.serialized_data : '',
    }
  })
}

/**
 * Validate workbooks. Each needs a unique display name (the reconciliation key)
 * and a serializedData blob that is present and parses as JSON — the content is
 * an opaque workbook definition, so only its JSON well-formedness is checked here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no workbooks', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const spec of extractWorkbookSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.display_name`, message: 'Workbook display name is required', code: 'required' })
    } else {
      const key = workbookKey(spec.displayName)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.display_name`,
          message: `Duplicate workbook display name "${spec.displayName}" (names must be unique)`,
          code: 'duplicate_workbook',
        })
      }
      seen.add(key)
    }

    if (!spec.serializedData.trim()) {
      errors.push({ field: `${prefix}.serialized_data`, message: 'Workbook JSON (serialized data) is required', code: 'required' })
    } else if (!isJsonParseable(spec.serializedData)) {
      errors.push({
        field: `${prefix}.serialized_data`,
        message: 'Workbook JSON is not valid JSON — the serialized workbook definition must parse',
        code: 'invalid_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
