import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps findings refinement deployment constraints ----------------
// The DEPLOYMENT state of an existing findings refinement (enabled / archived /
// which detectors the exclusion applies to) — the same content-vs-state split as
// the Rule Deployments type, applied to `findingsRefinements/{id}/deployment`.
// https://cloud.google.com/chronicle/docs/reference/rest/v1/projects.locations.instances.findingsRefinements
// (google_chronicle_findings_refinement_deployment in Google's own
// terraform-provider-google, GoogleCloudPlatform/magic-modules
// mmv1/products/chronicle/FindingsRefinementDeployment.yaml — the authoritative
// field list this type is built from).

export interface DetectionExclusionApplication {
  /** Rule DISPLAY NAMES (resolved to full `rules/{id}` paths at deploy time). */
  ruleNames: string[]
  /** Full `curatedRuleSetCategories/{cat}/curatedRuleSets/{set}` resource paths. */
  curatedRuleSets: string[]
  /** Full `curatedRules/{id}` resource paths. */
  curatedRules: string[]
}

export interface FindingsRefinementDeploymentSpec {
  itemId?: string
  /** refinementName = the parent findings refinement's displayName — resolved to its id. */
  refinementName: string
  enabled: boolean
  archived: boolean
  applicationRaw: string
  /** Parsed application scope, or null when the JSON is malformed. */
  application: DetectionExclusionApplication | null
}

/** A findings refinement deployment as returned by the SecOps API. */
export interface LiveFindingsRefinementDeployment {
  name?: string
  enabled?: boolean
  archived?: boolean
  detectionExclusionApplication?: {
    rules?: string[]
    curatedRuleSets?: string[]
    curatedRules?: string[]
    deletedCuratedRuleSets?: string[]
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : []
}

/** Parse the optional detectionExclusionApplication JSON blob, or null when malformed. */
export function parseApplication(raw: string): DetectionExclusionApplication | null {
  if (!raw) return { ruleNames: [], curatedRuleSets: [], curatedRules: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  return {
    ruleNames: asStringArray(obj.ruleNames),
    curatedRuleSets: asStringArray(obj.curatedRuleSets),
    curatedRules: asStringArray(obj.curatedRules),
  }
}

export function extractFindingsRefinementDeploymentSpecs(canvas: CanvasSnapshot): FindingsRefinementDeploymentSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const applicationRaw = asString(f.detectionExclusionApplication)
    return {
      itemId: item.id,
      refinementName: asString(f.refinementName) || item.name,
      enabled: asBool(f.enabled),
      archived: asBool(f.archived),
      applicationRaw,
      application: parseApplication(applicationRaw),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractFindingsRefinementDeploymentSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.refinementName) {
      errors.push({
        field: `${prefix}.refinementName`,
        message: 'Findings refinement name is required — it must match the display name of an existing findings refinement',
        code: 'required',
      })
    } else {
      const key = spec.refinementName.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.refinementName`, message: `Duplicate findings refinement deployment "${spec.refinementName}"`, code: 'duplicate_refinement' })
      }
      seenNames.add(key)
    }

    // Google's own constraint: archived cannot be set true unless enabled is false,
    // and an archived deployment cannot be updated back to enabled=true in the
    // same request (it must be unarchived first).
    if (spec.archived && spec.enabled) {
      errors.push({
        field: `${prefix}.archived`,
        message: 'A deployment cannot be both enabled and archived — archived requires enabled to be false',
        code: 'archived_with_enabled',
      })
    }

    if (spec.applicationRaw && !spec.application) {
      errors.push({
        field: `${prefix}.detectionExclusionApplication`,
        message: 'Detection exclusion application must be a JSON object, e.g. {"ruleNames":["My Rule"],"curatedRuleSets":[],"curatedRules":[]}',
        code: 'invalid_json',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
