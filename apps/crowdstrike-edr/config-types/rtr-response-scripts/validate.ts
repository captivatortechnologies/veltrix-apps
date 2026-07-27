import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Real Time Response custom-script API constraints -------------------------
//
// RTR custom scripts live on one Falcon collection:
//   query  GET    /real-time-response/queries/scripts/v1   (filter → ids)
//   get    GET    /real-time-response/entities/scripts/v1?ids=…
//   create POST   /real-time-response/entities/scripts/v1   (multipart/form-data)
//   update PATCH  /real-time-response/entities/scripts/v1   (multipart/form-data)
//   delete DELETE /real-time-response/entities/scripts/v1?ids=…
// A script's identity is its `name`. platform / permission_type / content are
// the managed body fields (see deploy.ts for the multipart caveat).
// -----------------------------------------------------------------------------

/** Sensor platforms a script can target (API sends these as an array). */
export const SCRIPT_PLATFORMS = ['windows', 'mac', 'linux'] as const
export type ScriptPlatform = (typeof SCRIPT_PLATFORMS)[number]

/** Who may run/see the script in the Falcon console. */
export const SCRIPT_PERMISSION_TYPES = ['private', 'group', 'public'] as const
export type ScriptPermissionType = (typeof SCRIPT_PERMISSION_TYPES)[number]

export const MAX_SCRIPT_NAME_LENGTH = 255
export const MAX_AUDIT_COMMENT_LENGTH = 4096

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ScriptSpec {
  sectionName: string
  name: string
  description: string
  platform: string
  permissionType: string
  content: string
  commentsForAuditLog?: string
}

/** Shape of a script returned by GET /real-time-response/entities/scripts/v1. */
export interface LiveRtrScript {
  id?: string
  name?: string
  description?: string
  /** The API stores platform as an array; older shapes may return a bare string. */
  platform?: string | string[]
  permission_type?: string
  /** Script body — returned by GET for scripts; compared on drift when present. */
  content?: string
  sha256?: string
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_timestamp?: string
}

/** Normalize a live/prior platform value to a lowercase string list. */
export function normalizePlatforms(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim().toLowerCase()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string' && value.trim()) return [value.trim().toLowerCase()]
  return []
}

/** Each canvas section describes one RTR custom script. */
export function extractScriptSpecs(canvas: CanvasSnapshot): ScriptSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      platform:
        typeof fields.platform === 'string' && fields.platform.trim()
          ? fields.platform.trim().toLowerCase()
          : 'windows',
      permissionType:
        typeof fields.permissionType === 'string' && fields.permissionType.trim()
          ? fields.permissionType.trim().toLowerCase()
          : 'private',
      // Content is stored verbatim (whitespace in a script body is significant).
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
 * Validate RTR custom-script configurations against the Real Time Response
 * Admin API constraints: name/description required, platform and
 * permission_type from the allowed sets, and a non-empty script body.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScriptSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — the script's identity
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Script name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_SCRIPT_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Script name must be ${MAX_SCRIPT_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate script "${spec.name}" — each script may only be declared once per canvas`,
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

    // platform
    if (!(SCRIPT_PLATFORMS as readonly string[]).includes(spec.platform)) {
      errors.push({
        field: `${prefix}.platform`,
        message: `Platform must be one of: ${SCRIPT_PLATFORMS.join(', ')}`,
        code: 'invalid_platform',
      })
    }

    // permission_type
    if (!(SCRIPT_PERMISSION_TYPES as readonly string[]).includes(spec.permissionType)) {
      errors.push({
        field: `${prefix}.permissionType`,
        message: `Permission type must be one of: ${SCRIPT_PERMISSION_TYPES.join(', ')}`,
        code: 'invalid_permission_type',
      })
    }

    // content — the script body
    if (!spec.content || spec.content.trim().length === 0) {
      errors.push({
        field: `${prefix}.content`,
        message: 'Script content is required',
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
