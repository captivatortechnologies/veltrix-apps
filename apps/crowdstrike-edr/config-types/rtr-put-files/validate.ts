import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Real Time Response put-file API constraints -----------------------------
//
// RTR put-files are files stageable to hosts via Real Time Response:
//   query  GET    /real-time-response/queries/put-files/v1   (filter → ids)
//   get    GET    /real-time-response/entities/put-files/v1?ids=…
//   create POST   /real-time-response/entities/put-files/v1  (multipart/form-data)
//   delete DELETE /real-time-response/entities/put-files/v1?ids=…
//
// There is NO PATCH: put-files are IMMUTABLE — an "update" is a delete followed
// by a recreate (see deploy.ts). A put-file's identity is its `name`.
// -----------------------------------------------------------------------------

export const MAX_PUT_FILE_NAME_LENGTH = 255
export const MAX_AUDIT_COMMENT_LENGTH = 4096

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface PutFileSpec {
  sectionName: string
  name: string
  description: string
  content: string
  commentsForAuditLog?: string
}

/** Shape of a put-file returned by GET /real-time-response/entities/put-files/v1. */
export interface LiveRtrPutFile {
  id?: string
  name?: string
  description?: string
  /** SHA-256 of the stored bytes — used to detect a content change (GET never returns the bytes). */
  sha256?: string
  size?: number
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_timestamp?: string
}

/** Each canvas section describes one RTR put-file. */
export function extractPutFileSpecs(canvas: CanvasSnapshot): PutFileSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      // File content is stored verbatim — whitespace/newlines are significant.
      content: typeof fields.content === 'string' ? fields.content : '',
      commentsForAuditLog:
        typeof fields.commentsForAuditLog === 'string' && fields.commentsForAuditLog.trim()
          ? fields.commentsForAuditLog.trim()
          : undefined,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate RTR put-file configurations against the Real Time Response Admin
 * API constraints: name and description are required, and the file must have
 * non-empty content.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPutFileSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — the put-file's identity
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Put-file name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_PUT_FILE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Put-file name must be ${MAX_PUT_FILE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate put-file "${spec.name}" — each put-file may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // description — required by the RTR Admin API
    if (!spec.description) {
      errors.push({
        field: `${prefix}.description`,
        message: 'Description is required',
        code: 'required',
      })
    }

    // content — the file body
    if (!spec.content || spec.content.trim().length === 0) {
      errors.push({
        field: `${prefix}.content`,
        message: 'File content is required',
        code: 'required',
      })
    }

    // audit comment length
    if (spec.commentsForAuditLog && spec.commentsForAuditLog.length > MAX_AUDIT_COMMENT_LENGTH) {
      errors.push({
        field: `${prefix}.commentsForAuditLog`,
        message: `Audit-log comment must be ${MAX_AUDIT_COMMENT_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
