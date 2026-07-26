import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk import targets — import a source-control repository into Snyk through a
// CONFIGURED integration via the v1 Import API
// (POST /org/{orgId}/integrations/{integrationId}/import), which creates Snyk
// projects. Import is ASYNCHRONOUS (the POST returns 201 with a job URL in the
// Location header). Identity is the target (owner/name) reached through the
// integration; the deploy skips a target that already exists (checked against the
// REST Targets API) so re-deploys are idempotent. There is no secret.
//
// Supported source types all use an owner + name (+ branch) repository target:
// github, github-enterprise, azure-repos and bitbucket-cloud.
// =============================================================================

export const SCM_TYPES = ['github', 'github-enterprise', 'azure-repos', 'bitbucket-cloud'] as const
export type ScmType = (typeof SCM_TYPES)[number]

/** Source types for which the v1 API requires a branch on the repo target. */
export const BRANCH_REQUIRED_TYPES: readonly string[] = ['github', 'github-enterprise', 'azure-repos']

export interface ImportTargetSpec {
  sectionName: string
  integrationId: string
  scmType: string
  owner: string
  name: string
  /** Branch — present only when the user set one. */
  branch?: string
  /** Comma-separated exclusion globs — present only when the user set a value. */
  exclusionGlobs?: string
}

/** The repository target sent to the v1 Import API. */
export interface RepoTarget {
  owner: string
  name: string
  branch?: string
}

/** A target as returned by the REST Targets API (GET /orgs/{org_id}/targets). */
export interface LiveTarget {
  id?: string
  attributes?: {
    display_name?: string
    url?: string
  }
}

/** The `owner/name` display name is a target's logical identity. */
export function targetDisplayName(owner: string, name: string): string {
  return `${owner.trim()}/${name.trim()}`
}

/** Normalized identity key (integration + owner/name), case-insensitive. */
export function targetKey(integrationId: string, owner: string, name: string): string {
  return `${integrationId.trim().toLowerCase()}::${targetDisplayName(owner, name).toLowerCase()}`
}

/** Each canvas item describes one repository to import. */
export function extractImportTargetSpecs(canvas: CanvasSnapshot): ImportTargetSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const branch = typeof fields.branch === 'string' && fields.branch.trim() ? fields.branch.trim() : undefined
    const globs =
      typeof fields.exclusion_globs === 'string' && fields.exclusion_globs.trim()
        ? fields.exclusion_globs.trim()
        : undefined
    return {
      sectionName: section.name,
      integrationId: typeof fields.integration_id === 'string' ? fields.integration_id.trim() : '',
      scmType: typeof fields.scm_type === 'string' && fields.scm_type.trim() ? fields.scm_type.trim() : 'github',
      owner: typeof fields.owner === 'string' ? fields.owner.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      branch,
      exclusionGlobs: globs,
    }
  })
}

/** Build the v1 repo target body for a spec. `branch` is only sent when present. */
export function toRepoTarget(spec: ImportTargetSpec): RepoTarget {
  return {
    owner: spec.owner,
    name: spec.name,
    ...(spec.branch ? { branch: spec.branch } : {}),
  }
}

/**
 * Validate import-target configurations: an integration id, supported source
 * type, owner and repository name are required; a branch is required for the
 * source types the API mandates it; and each (integration, owner/name) target is
 * unique.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no import target items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractImportTargetSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.integrationId) {
      errors.push({ field: `${prefix}.integration_id`, message: 'Integration ID is required', code: 'required' })
    }
    if (!SCM_TYPES.includes(spec.scmType as ScmType)) {
      errors.push({
        field: `${prefix}.scm_type`,
        message: `Unsupported source type "${spec.scmType}" — must be one of: ${SCM_TYPES.join(', ')}`,
        code: 'invalid_scm_type',
      })
    }
    if (!spec.owner) {
      errors.push({ field: `${prefix}.owner`, message: 'Owner is required', code: 'required' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Repository name is required', code: 'required' })
    }
    if (!spec.branch && BRANCH_REQUIRED_TYPES.includes(spec.scmType)) {
      errors.push({
        field: `${prefix}.branch`,
        message: `A branch is required for ${spec.scmType} import targets`,
        code: 'branch_required',
      })
    }

    if (spec.integrationId && spec.owner && spec.name) {
      const key = targetKey(spec.integrationId, spec.owner, spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate target "${targetDisplayName(spec.owner, spec.name)}" for this integration — each target may only be declared once`,
          code: 'duplicate_target',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
