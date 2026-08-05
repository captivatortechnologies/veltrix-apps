import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { buildResourceYaml, hasNonEmptySpec, parseResourceHeader } from '../../lib/resourceYaml'

export const ROLE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/
export const ROLE_VERSIONS = new Set(['v3', 'v4', 'v5', 'v6', 'v7'])
export const KIND = 'role'

/** Well-known Teleport preset roles — editing them is allowed but worth a heads-up, not an error. */
const PRESET_ROLE_NAMES = new Set(['access', 'editor', 'auditor'])

export interface RoleSpec {
  sectionName: string
  name: string
  version: string
  spec: string
}

/** Each canvas item describes one Teleport role. */
export function extractRoleSpecs(canvas: CanvasSnapshot): RoleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    const version = typeof fields.version === 'string' && fields.version.trim() ? fields.version.trim() : 'v7'
    const spec = typeof fields.spec === 'string' ? fields.spec.trim() : ''
    return { sectionName: section.name, name, version, spec }
  })
}

/** Build the full role resource YAML Teleport's web API expects. */
export function buildRoleYaml(spec: RoleSpec): string {
  return buildResourceYaml(KIND, spec.version, spec.name, spec.spec)
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRoleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required', code: 'required' })
    } else {
      if (!ROLE_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Role name may only contain letters, numbers, dots, underscores and hyphens',
          code: 'invalid_name',
        })
      }
      if (PRESET_ROLE_NAMES.has(spec.name)) {
        warnings.push({
          field: `${prefix}.name`,
          message: `"${spec.name}" is a built-in preset role — deploying will update it in place, affecting every user/bot it is already assigned to.`,
          code: 'preset_role',
        })
      }
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate role "${spec.name}" — each role name may only be declared once per canvas`,
          code: 'duplicate_role',
        })
      }
      seenNames.add(spec.name)
    }

    if (!ROLE_VERSIONS.has(spec.version)) {
      errors.push({
        field: `${prefix}.version`,
        message: `Resource version must be one of ${[...ROLE_VERSIONS].join(', ')} (got "${spec.version}")`,
        code: 'invalid_version',
      })
    }

    if (!spec.spec || !hasNonEmptySpec(spec.spec)) {
      errors.push({ field: `${prefix}.spec`, message: 'Role spec is required', code: 'required' })
    } else {
      const header = parseResourceHeader(spec.spec)
      if (header.kind || header.name) {
        errors.push({
          field: `${prefix}.spec`,
          message:
            'Spec must contain only the role\'s `spec:` body (allow/deny/options) — do not include a ' +
            'kind/metadata/version envelope, it is added automatically',
          code: 'unexpected_envelope',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
