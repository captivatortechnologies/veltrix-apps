// =============================================================================
// Defender for Endpoint LIVE RESPONSE LIBRARY — spec model + validation.
//
// This config type manages the tenant-wide Live Response library (the scripts /
// tools analysts can run in a live response session) via:
//   GET    /api/libraryfiles              — list (metadata only, no content)
//   POST   /api/libraryfiles               — upload (multipart/form-data; upsert
//                                             via OverrideIfExists)
//   DELETE /api/libraryfiles/{fileName}    — delete
// (verified — needs the Library.Manage application permission, distinct from
// Ti.ReadWrite.All / Machine.ReadWrite.All used elsewhere in this app). Identity
// is `file_name` — the library is a single flat, tenant-wide namespace.
//
// Like detection-rules and machine-tags, this type is self-contained: it owns
// the spec model and the deploy / rollback / drift / health handlers import it
// from here. It reuses lib/mde.ts for the API client only.
//
// IMPORTANT LIMITATION (verified against the documented API surface): Defender
// exposes no "download library file content" endpoint — GET /api/libraryfiles
// returns only metadata (fileName, sha256, description, hasParameters,
// parametersDescription, createdBy, timestamps), never the bytes. So while a
// NEWLY CREATED file can be cleanly rolled back (delete it), a file this deploy
// OVERWROTE (it already existed, e.g. from an earlier deploy of the same item,
// the portal, or another tool) can never have its exact prior content restored
// by rollback — there is nothing to read it back from. See rollback.ts.
// =============================================================================

import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/** Documented ceiling for one library file (verified in the Upload API's Limitations section). */
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024

/** No path separators or characters Windows/NTFS reject in a file name. */
const FILE_NAME_PATTERN = /^[^\\/:*?"<>|\r\n]{1,255}$/

/** One declared library file, extracted from a canvas item. */
export interface LibraryFileSpec {
  sectionName: string
  fileName: string
  description: string
  hasParameters: boolean
  parametersDescription: string
  content: string
}

/** A library file's metadata as returned by GET /api/libraryfiles (never the content). */
export interface LiveLibraryFile {
  fileName?: string
  sha256?: string
  description?: string | null
  hasParameters?: boolean
  parametersDescription?: string | null
  createdBy?: string | null
  creationTime?: string | null
  lastUpdatedTime?: string | null
}

/** Case-insensitive file-name key — Windows file names are not case-sensitive. */
export function fileNameKey(fileName: string): string {
  return fileName.trim().toLowerCase()
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'true' || t === 'yes' || t === '1') return true
    if (t === 'false' || t === 'no' || t === '0' || t === '') return false
  }
  return fallback
}

/** Each canvas item describes one library file. `content` is NOT trimmed — leading/trailing whitespace may matter in a script. */
export function extractLibraryFileSpecs(canvas: CanvasSnapshot): LibraryFileSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      fileName: readString(fields.file_name),
      description: readString(fields.description),
      hasParameters: readBool(fields.has_parameters, false),
      parametersDescription: readString(fields.parameters_description),
      content: typeof fields.content === 'string' ? fields.content : '',
    }
  })
}

/**
 * Validate declared library files: each needs a valid file name (no path
 * separators, 1-255 chars) and non-empty content within the 20 MB API limit;
 * the file name is unique (case-insensitive) across the canvas; a script
 * declared as parameterized should describe its parameters.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no library files', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractLibraryFileSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.fileName) {
      errors.push({ field: `${prefix}.file_name`, message: 'File name is required', code: 'required' })
    } else if (!FILE_NAME_PATTERN.test(spec.fileName)) {
      errors.push({
        field: `${prefix}.file_name`,
        message: `File name "${spec.fileName}" must not contain a path separator (\\ or /) or reserved character, and be 1-255 characters`,
        code: 'invalid_file_name',
      })
    }

    if (!spec.content) {
      errors.push({ field: `${prefix}.content`, message: 'File content is required', code: 'required' })
    } else if (Buffer.byteLength(spec.content, 'utf8') > MAX_FILE_SIZE_BYTES) {
      errors.push({
        field: `${prefix}.content`,
        message: `Content is larger than the documented 20 MB Live Response library limit`,
        code: 'file_too_large',
      })
    }

    if (spec.hasParameters && !spec.parametersDescription) {
      warnings.push({
        field: `${prefix}.parameters_description`,
        message: 'A parameters description is recommended when "Accepts parameters" is enabled',
        code: 'parameters_description_recommended',
      })
    }

    if (spec.fileName) {
      const key = fileNameKey(spec.fileName)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.file_name`, message: `Duplicate file name "${spec.fileName}"`, code: 'duplicate_file_name' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
