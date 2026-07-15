import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Folders API constraints ------------------------------------------

/** A folder name is capped at a sensible 255 characters. */
export const MAX_FOLDER_NAME_LENGTH = 255

/**
 * Tenable ships two built-in SYSTEM folders — "My Scans" and "Trash" — that
 * cannot be renamed or deleted. This config type must never target them, so a
 * declared folder may not take either name. Compared case-insensitively so a
 * lowercase "trash" (which the console would still resolve to the system
 * folder) is rejected too.
 */
export const SYSTEM_FOLDER_NAMES = ['My Scans', 'Trash']

/** True when `name` is one of Tenable's reserved system-folder names. */
export function isSystemFolderName(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  return SYSTEM_FOLDER_NAMES.some((n) => n.toLowerCase() === normalized)
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface FolderSpec {
  sectionName: string
  /** Folder name — the logical identity; Tenable assigns the numeric id. */
  name: string
}

/** Shape of a folder returned by GET /folders. */
export interface LiveFolder {
  id?: number
  name?: string
  /** "custom" for user folders, "system" for My Scans / Trash. */
  type?: string
}

/** Each canvas section describes one Tenable folder (identified by its name). */
export function extractFolderSpecs(canvas: CanvasSnapshot): FolderSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate folder configurations against Tenable Folders API constraints:
 * a name is required, is capped at 255 characters, may not be one of Tenable's
 * system folders ("My Scans" / "Trash" — which are not editable or deletable),
 * and the name — a folder's logical identity — must be unique per canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractFolderSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, and never a Tenable system folder
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Folder name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_FOLDER_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Folder name must be ${MAX_FOLDER_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      // Guard the system folders at the static layer so a bad name never even
      // reaches deploy (deploy also refuses live folders of type "system").
      if (isSystemFolderName(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `"${spec.name}" is a Tenable system folder (My Scans / Trash) and cannot be managed`,
          code: 'system_folder',
        })
      }
    }

    // name is the folder's logical identity — dedupe on it. Matched exactly
    // (not case-folded): Tenable stores folder names as literal strings.
    if (spec.name) {
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate folder "${spec.name}" — each folder name may only be declared once per canvas`,
          code: 'duplicate_folder',
        })
      }
      seenNames.add(spec.name)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
