import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Repository backends a source control can bind to. Microsoft.SecurityInsights
 * sourcecontrols supports GitHub and Azure DevOps only.
 */
export const REPO_TYPES = ['Github', 'AzureDevOps'] as const
export type RepoType = (typeof REPO_TYPES)[number]

/**
 * Microsoft.SecurityInsights ContentType enum — the artifact kinds a repository
 * connection can deploy into the workspace as content-as-code.
 */
export const CONTENT_TYPES = [
  'AnalyticsRule',
  'AutomationRule',
  'HuntingQuery',
  'Parser',
  'Playbook',
  'Workbook',
] as const
export type ContentType = (typeof CONTENT_TYPES)[number]

/**
 * RepositoryAccessKind — how the connection authenticates to the repo. The
 * credential itself (token / OAuth code / installation id) is WRITE-ONLY: sent on
 * create/update and never returned on GET.
 */
export const ACCESS_KINDS = ['OAuth', 'PAT', 'App'] as const
export type AccessKind = (typeof ACCESS_KINDS)[number]

/** Source control content-as-code contract version. */
export const VERSIONS = ['V1', 'V2'] as const
export type SourceControlVersion = (typeof VERSIONS)[number]

/** A repository URL must be an http(s) URL. */
const REPO_URL_RE = /^https?:\/\/\S+$/i

/**
 * One source control (repository connection) authored on the canvas.
 *
 * `accessToken` is the SECRET repositoryAccess credential — it is NEVER logged,
 * NEVER written to rollbackData/artifacts, and NEVER compared during drift.
 */
export interface SourceControlSpec {
  sectionName: string
  /** The display name — the reconciliation identity (server id is a server GUID). */
  displayName: string
  description: string
  repoType: string
  repoUrl: string
  repoBranch: string
  contentTypes: string[]
  accessKind: string
  /** WRITE-ONLY secret credential (PAT token / OAuth code / App installation id). */
  accessToken: string
  version: string
}

/** The reconciliation key is the display name (lower-cased for matching). */
export function sourceControlKey(displayName: string): string {
  return displayName.trim().toLowerCase()
}

/** Read a multiselect/list field into a trimmed, de-duplicated string array. */
export function readList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v).trim())
    : typeof value === 'string'
      ? value.split(',').map((v) => v.trim())
      : []
  const out: string[] = []
  for (const v of raw) if (v && !out.includes(v)) out.push(v)
  return out
}

/** Each canvas item is one source control (repository connection). */
export function extractSourceControlSpecs(canvas: CanvasSnapshot): SourceControlSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (key: string): string => (typeof fields[key] === 'string' ? (fields[key] as string).trim() : '')
    return {
      sectionName: section.name,
      displayName: str('display_name'),
      description: str('description'),
      repoType: str('repo_type') || 'Github',
      repoUrl: str('repo_url'),
      repoBranch: str('repo_branch'),
      contentTypes: readList(fields.content_types),
      accessKind: str('access_kind') || 'PAT',
      accessToken: str('access_token'),
      version: str('version') || 'V2',
    }
  })
}

/**
 * Build the WRITE-ONLY repositoryAccess credential object for a spec. The single
 * canvas secret maps to the field the chosen kind requires:
 *   - PAT   → token           (Personal Access Token)
 *   - OAuth → code            (OAuth authorization code)
 *   - App   → installationId  (GitHub App installation id)
 * Returns undefined when no secret is supplied, so an update leaves the stored
 * credential untouched.
 */
export function buildRepositoryAccess(
  accessKind: string,
  accessToken: string,
): Record<string, string> | undefined {
  if (!accessToken) return undefined
  switch (accessKind) {
    case 'PAT':
      return { kind: 'PAT', token: accessToken }
    case 'OAuth':
      return { kind: 'OAuth', code: accessToken }
    case 'App':
      return { kind: 'App', installationId: accessToken }
    default:
      return { kind: accessKind, token: accessToken }
  }
}

/** The non-secret properties block — everything sent to ARM except repositoryAccess. */
export interface SourceControlProperties {
  displayName: string
  description?: string
  repoType: string
  contentTypes: string[]
  repository: { url: string; branch: string; displayUrl?: string }
  version: string
}

/** Build the non-secret SourceControl properties block for a spec. */
export function buildSourceControlProperties(spec: SourceControlSpec): SourceControlProperties {
  return {
    displayName: spec.displayName,
    description: spec.description || undefined,
    repoType: spec.repoType,
    contentTypes: spec.contentTypes,
    repository: { url: spec.repoUrl, branch: spec.repoBranch },
    version: spec.version,
  }
}

/**
 * The Microsoft.SecurityInsights SourceControl request body for a spec. The
 * non-secret properties always go in; the WRITE-ONLY repositoryAccess credential
 * is attached only when a secret was supplied.
 */
export function buildSourceControlBody(spec: SourceControlSpec): unknown {
  const properties: Record<string, unknown> = { ...buildSourceControlProperties(spec) }
  const access = buildRepositoryAccess(spec.accessKind, spec.accessToken)
  if (access) properties.repositoryAccess = access
  return { properties }
}

/**
 * Keep only the non-secret properties from a live SourceControl, for rollback
 * capture. repositoryAccess is write-only and never returned on GET, so this can
 * never carry a secret — but the whitelist makes that guarantee explicit.
 */
export function pickNonSecretProperties(properties: unknown): SourceControlProperties {
  const p = (properties ?? {}) as Record<string, unknown>
  const repo = (p.repository ?? {}) as Record<string, unknown>
  const repository: SourceControlProperties['repository'] = {
    url: typeof repo.url === 'string' ? repo.url : '',
    branch: typeof repo.branch === 'string' ? repo.branch : '',
  }
  if (typeof repo.displayUrl === 'string' && repo.displayUrl) repository.displayUrl = repo.displayUrl
  return {
    displayName: typeof p.displayName === 'string' ? p.displayName : '',
    description: typeof p.description === 'string' ? p.description : undefined,
    repoType: typeof p.repoType === 'string' ? p.repoType : '',
    contentTypes: Array.isArray(p.contentTypes) ? p.contentTypes.map((v) => String(v)) : [],
    repository,
    version: typeof p.version === 'string' ? p.version : '',
  }
}

/** Order-independent, case-preserving comparison key for a content-type array. */
export function contentTypesKey(values: string[]): string {
  return [...values].map((v) => String(v)).sort().join(',')
}

/**
 * True when a live source control already matches the declared non-secret config
 * (repo type, content types, repository url/branch, version) — the same fields
 * drift compares. Deploy uses this to SKIP a no-op re-PUT: a bare PUT of an
 * existing sourcecontrol re-runs repository provisioning and re-consumes the
 * write-only credential, so an unchanged connection with no new credential is left
 * untouched to avoid silently breaking a working repo webhook / pipeline.
 */
export function sourceControlUnchanged(spec: SourceControlSpec, liveProperties: unknown): boolean {
  const live = pickNonSecretProperties(liveProperties)
  return (
    spec.repoType === live.repoType &&
    spec.repoUrl === live.repository.url &&
    spec.repoBranch === live.repository.branch &&
    spec.version === live.version &&
    contentTypesKey(spec.contentTypes) === contentTypesKey(live.contentTypes)
  )
}

/**
 * Validate source controls. Each needs a unique display name, a supported repo
 * type, an http(s) repository URL, a branch, and at least one valid content type.
 * The repositoryAccess credential is NOT required here — leaving it blank on an
 * update keeps the stored credential (a warning flags a blank credential since it
 * is required on first deploy).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no source controls', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const spec of extractSourceControlSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.display_name`, message: 'Display name is required', code: 'required' })
    } else {
      const key = sourceControlKey(spec.displayName)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.display_name`,
          message: `Duplicate source control name "${spec.displayName}" (names must be unique, case-insensitive)`,
          code: 'duplicate_source_control',
        })
      }
      seen.add(key)
    }

    if (!REPO_TYPES.includes(spec.repoType as RepoType)) {
      errors.push({
        field: `${prefix}.repo_type`,
        message: `Repository type must be one of ${REPO_TYPES.join(', ')}`,
        code: 'invalid_repo_type',
      })
    }

    if (!spec.repoUrl) {
      errors.push({ field: `${prefix}.repo_url`, message: 'Repository URL is required', code: 'required' })
    } else if (!REPO_URL_RE.test(spec.repoUrl)) {
      errors.push({
        field: `${prefix}.repo_url`,
        message: `Repository URL "${spec.repoUrl}" must be an http(s) URL`,
        code: 'invalid_repo_url',
      })
    }

    if (!spec.repoBranch) {
      errors.push({ field: `${prefix}.repo_branch`, message: 'Repository branch is required', code: 'required' })
    }

    if (spec.contentTypes.length === 0) {
      errors.push({ field: `${prefix}.content_types`, message: 'Select at least one content type', code: 'no_content_type' })
    } else {
      for (const ct of spec.contentTypes) {
        if (!CONTENT_TYPES.includes(ct as ContentType)) {
          errors.push({
            field: `${prefix}.content_types`,
            message: `Invalid content type "${ct}" — must be one of ${CONTENT_TYPES.join(', ')}`,
            code: 'invalid_content_type',
          })
        }
      }
    }

    if (!ACCESS_KINDS.includes(spec.accessKind as AccessKind)) {
      errors.push({
        field: `${prefix}.access_kind`,
        message: `Access kind must be one of ${ACCESS_KINDS.join(', ')}`,
        code: 'invalid_access_kind',
      })
    }

    if (!VERSIONS.includes(spec.version as SourceControlVersion)) {
      errors.push({
        field: `${prefix}.version`,
        message: `Version must be one of ${VERSIONS.join(', ')}`,
        code: 'invalid_version',
      })
    }

    // App-kind installation ids are supported for GitHub only.
    if (spec.accessKind === 'App' && spec.repoType === 'AzureDevOps') {
      errors.push({
        field: `${prefix}.access_kind`,
        message: 'App (installation id) access is supported for GitHub only — use PAT or OAuth for Azure DevOps',
        code: 'access_kind_repo_mismatch',
      })
    }

    // The credential is write-only, so we can't tell create from update here. Warn
    // (not error) on a blank credential — it is required on first deploy but may be
    // intentionally omitted on an update to keep the stored credential.
    if (spec.displayName && !spec.accessToken) {
      warnings.push({
        field: `${prefix}.access_token`,
        message: 'No repository credential supplied — required on first deploy; leave blank on update to keep the existing credential',
        code: 'missing_credential',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
