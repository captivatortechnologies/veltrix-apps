import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { toList } from '../roles/validate'

// --- OneLogin Privileges API constraints -----------------------------------------
// https://developers.onelogin.com/api-docs/1/privileges
//
// GET/POST       /api/1/privileges              - list / create
// GET/PUT/DELETE /api/1/privileges/{id}         - read / replace / delete
// GET/POST       /api/1/privileges/{id}/roles   - get assigned / ADD (union)
// DELETE         /api/1/privileges/{id}/roles/{role_id}  - remove ONE
// GET/POST       /api/1/privileges/{id}/users   - get assigned / ADD (union)
// DELETE         /api/1/privileges/{id}/users/{user_id}  - remove ONE
//
// Requires a OneLogin subscription that includes Delegated Administration.
// A privilege's logical identity in this config type is its NAME - OneLogin
// has no upsert, so this app matches an existing privilege by name.

export interface PrivilegeStatement {
  Effect: 'Allow' | 'Deny'
  Action: string[]
  Scope: string[]
}
export interface PrivilegeDocument {
  Version: string
  Statement: PrivilegeStatement[]
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface PrivilegeSpec {
  sectionName: string
  name: string
  description?: string
  statementJson: string
  roleIds: number[]
  userIds: number[]
}

/** Shape of a privilege returned by GET /api/1/privileges (list) and GET .../{id}. */
export interface LivePrivilege {
  id?: string
  name?: string
  description?: string
  privilege?: PrivilegeDocument
  [key: string]: unknown
}

function trimmedOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function toIdList(value: unknown): number[] {
  return toList(value)
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/** Each canvas item describes one OneLogin privilege. */
export function extractPrivilegeSpecs(canvas: CanvasSnapshot): PrivilegeSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: trimmedOrUndefined(fields.description),
      statementJson: trimmedOrUndefined(fields.statementJson) ?? '',
      roleIds: toIdList(fields.roleIds),
      userIds: toIdList(fields.userIds),
    }
  })
}

/** Parse+validate a privilege statement document; null when malformed or the wrong shape. */
export function parsePrivilegeDocument(raw: string): PrivilegeDocument | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>
  if (typeof doc.Version !== 'string' || !doc.Version.trim()) return null
  if (!Array.isArray(doc.Statement) || doc.Statement.length === 0) return null
  const valid = doc.Statement.every((s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false
    const stmt = s as Record<string, unknown>
    return (
      (stmt.Effect === 'Allow' || stmt.Effect === 'Deny') &&
      Array.isArray(stmt.Action) &&
      stmt.Action.length > 0 &&
      stmt.Action.every((a) => typeof a === 'string') &&
      Array.isArray(stmt.Scope) &&
      stmt.Scope.every((s2) => typeof s2 === 'string')
    )
  })
  if (!valid) return null
  return doc as unknown as PrivilegeDocument
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate privilege configurations against the OneLogin Privileges API.
 * Static only - it never contacts OneLogin (the Roles picker is resolved
 * live by the platform's remote-select UI via options.ts, not here):
 *   - name is required and unique across the canvas
 *   - statementJson must parse to a well-formed {Version, Statement[]} document
 *   - every declared roleId/userId (from the multiselect/tags raw value)
 *     must be a positive integer
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPrivilegeSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName
    const rawFields = (sections.find((s) => s.name === spec.sectionName)?.fields ?? {}) as Record<string, unknown>

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Privilege name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate privilege "${spec.name}" - each privilege name may only be declared once per canvas`,
        code: 'duplicate_privilege',
      })
    }
    if (spec.name) seenNames.add(spec.name)

    if (!spec.statementJson) {
      errors.push({ field: `${prefix}.statementJson`, message: 'Statement is required', code: 'required' })
    } else if (!parsePrivilegeDocument(spec.statementJson)) {
      errors.push({
        field: `${prefix}.statementJson`,
        message:
          'Statement must be a valid policy document, e.g. {"Version":"2018-05-18","Statement":[{"Effect":"Allow","Action":["users:Get"],"Scope":["*"]}]}',
        code: 'invalid_statement',
      })
    }

    const rawRoleIds = toList(rawFields.roleIds)
    const invalidRoleIds = rawRoleIds.filter((v) => !Number.isInteger(Number(v)) || Number(v) <= 0)
    if (invalidRoleIds.length > 0) {
      errors.push({
        field: `${prefix}.roleIds`,
        message: `Assigned Roles must be positive integer role ids (got: ${invalidRoleIds.join(', ')})`,
        code: 'invalid_role_id',
      })
    }

    const rawUserIds = toList(rawFields.userIds)
    const invalidUserIds = rawUserIds.filter((v) => !Number.isInteger(Number(v)) || Number(v) <= 0)
    if (invalidUserIds.length > 0) {
      errors.push({
        field: `${prefix}.userIds`,
        message: `Assigned User IDs must be positive integers (got: ${invalidUserIds.join(', ')})`,
        code: 'invalid_user_id',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
