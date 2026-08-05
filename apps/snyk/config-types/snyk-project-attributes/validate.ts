import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk project attributes — manage an EXISTING project's classification
// metadata via the REST API (GET/PATCH /orgs/{org_id}/projects/{project_id},
// GA since 2024-05-31). This is DISTINCT from config-types/snyk-project-settings
// (the v1 pull-request-test / auto-dependency-upgrade booleans): this type
// manages business_criticality, environment, lifecycle, tags, the project's
// owner, and `test_frequency` (a scheduled re-test cadence — reported on GET
// under `settings.recurring_tests.frequency`, written via the flat
// `test_frequency` shorthand on PATCH).
//
// This config type UPDATES a project in place — it never creates or deletes
// one — and identity is the project id. There is no secret. Declarative:
// business_criticality/environment/lifecycle/tags are always sent (an empty
// selection clears prior values); test_frequency and the owner are sent only
// when the operator set them, so leaving them blank never touches Snyk's
// existing value.
// =============================================================================

export const BUSINESS_CRITICALITIES = ['critical', 'high', 'medium', 'low'] as const
export const ENVIRONMENTS = [
  'frontend',
  'backend',
  'internal',
  'external',
  'mobile',
  'saas',
  'onprem',
  'hosted',
  'distributed',
] as const
export const LIFECYCLES = ['production', 'development', 'sandbox'] as const
export const TEST_FREQUENCIES = ['daily', 'weekly', 'never'] as const

export interface ProjectAttributesSpec {
  sectionName: string
  projectId: string
  businessCriticality: string[]
  environment: string[]
  lifecycle: string[]
  tags: Record<string, string>
  /** Blank means "not managed" — the field is omitted from every write. */
  testFrequency: string
  /** Blank means "not managed" — the owner relationship is omitted from every write. */
  ownerUserId: string
}

/** The subset of `ProjectAttributes` (REST) this config type manages. */
export interface LiveProjectAttributes {
  business_criticality?: string[]
  environment?: string[]
  lifecycle?: string[]
  tags?: Array<{ key?: string; value?: string }>
  settings?: { recurring_tests?: { frequency?: string } }
}

/** The JSON:API project resource, as returned by GET /orgs/{org_id}/projects/{project_id}. */
export interface LiveProject {
  id?: string
  type?: string
  attributes?: LiveProjectAttributes
  relationships?: { owner?: { data?: { id?: string | null } } }
}

/** The project id is a project's logical identity. */
export function projectKey(projectId: string): string {
  return projectId.trim().toLowerCase()
}

/** Read a multiselect/tags-ish field into a trimmed, de-duplicated string array. */
export function toStringArray(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v ?? '').trim())
    : typeof value === 'string'
      ? value.split(/[\n,]+/).map((s) => s.trim())
      : []
  return [...new Set(raw.filter(Boolean))]
}

/** Read a `keyvalue` field into a plain string map (blank/non-object → `{}`). */
export function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const trimmedKey = key.trim()
    if (trimmedKey) out[trimmedKey] = String(v ?? '')
  }
  return out
}

/** Snyk's `tags` wire shape is an array of `{ key, value }` — convert a map to it, sorted for determinism. */
export function tagsRecordToArray(tags: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }))
}

/** The inverse of {@link tagsRecordToArray} — read Snyk's `tags` array back into a map. */
export function tagsArrayToRecord(tags: Array<{ key?: string; value?: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of tags ?? []) {
    if (t?.key) out[t.key] = t.value ?? ''
  }
  return out
}

/**
 * The `attributes` object Snyk expects on PATCH, given a spec. Declarative:
 * the three classification arrays and tags are always sent; test_frequency
 * only when the operator set one.
 */
export function buildAttributesBody(spec: {
  businessCriticality: string[]
  environment: string[]
  lifecycle: string[]
  tags: Record<string, string>
  testFrequency: string
}): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    business_criticality: spec.businessCriticality,
    environment: spec.environment,
    lifecycle: spec.lifecycle,
    tags: tagsRecordToArray(spec.tags),
  }
  if (spec.testFrequency) attrs.test_frequency = spec.testFrequency
  return attrs
}

/** Each canvas item describes one project's managed attributes. */
export function extractProjectAttributesSpecs(canvas: CanvasSnapshot): ProjectAttributesSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawFrequency = typeof fields.test_frequency === 'string' ? fields.test_frequency.trim().toLowerCase() : ''
    return {
      sectionName: section.name,
      projectId: typeof fields.project_id === 'string' ? fields.project_id.trim() : '',
      businessCriticality: toStringArray(fields.business_criticality),
      environment: toStringArray(fields.environment),
      lifecycle: toStringArray(fields.lifecycle),
      tags: toStringRecord(fields.tags),
      testFrequency: rawFrequency,
      ownerUserId: typeof fields.owner_user_id === 'string' ? fields.owner_user_id.trim() : '',
    }
  })
}

/**
 * Validate project-attributes configurations: a project id is required, every
 * business-criticality/environment/lifecycle value is from Snyk's fixed enum,
 * an explicit test frequency (when set) is one of daily/weekly/never, and each
 * project id may only be declared once.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no project items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractProjectAttributesSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.projectId) {
      errors.push({ field: `${prefix}.project_id`, message: 'Project ID is required', code: 'required' })
    }

    for (const value of spec.businessCriticality) {
      if (!BUSINESS_CRITICALITIES.includes(value as (typeof BUSINESS_CRITICALITIES)[number])) {
        errors.push({
          field: `${prefix}.business_criticality`,
          message: `Invalid business criticality "${value}" — must be one of: ${BUSINESS_CRITICALITIES.join(', ')}`,
          code: 'invalid_business_criticality',
        })
      }
    }
    for (const value of spec.environment) {
      if (!ENVIRONMENTS.includes(value as (typeof ENVIRONMENTS)[number])) {
        errors.push({
          field: `${prefix}.environment`,
          message: `Invalid environment "${value}" — must be one of: ${ENVIRONMENTS.join(', ')}`,
          code: 'invalid_environment',
        })
      }
    }
    for (const value of spec.lifecycle) {
      if (!LIFECYCLES.includes(value as (typeof LIFECYCLES)[number])) {
        errors.push({
          field: `${prefix}.lifecycle`,
          message: `Invalid lifecycle "${value}" — must be one of: ${LIFECYCLES.join(', ')}`,
          code: 'invalid_lifecycle',
        })
      }
    }
    if (spec.testFrequency && !TEST_FREQUENCIES.includes(spec.testFrequency as (typeof TEST_FREQUENCIES)[number])) {
      errors.push({
        field: `${prefix}.test_frequency`,
        message: `Invalid test frequency "${spec.testFrequency}" — must be one of: ${TEST_FREQUENCIES.join(', ')}`,
        code: 'invalid_test_frequency',
      })
    }

    if (spec.projectId) {
      const key = projectKey(spec.projectId)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.project_id`,
          message: `Duplicate project "${spec.projectId}" — each project may only be declared once`,
          code: 'duplicate_project',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
