import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/falcon'

// --- Cloud Groups API constraints --------------------------------------------

/** How critical a group's assets are — Falcon `business_impact` values. */
export const BUSINESS_IMPACTS = ['high', 'moderate', 'low'] as const
export type BusinessImpact = (typeof BUSINESS_IMPACTS)[number]

/** Deployment stage — Falcon `environment` values. */
export const ENVIRONMENTS = ['dev', 'test', 'stage', 'prod'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

/** Cloud providers a scoping block may target. GCP does not support tag filters. */
export const CLOUD_PROVIDERS = ['aws', 'azure', 'gcp'] as const
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number]

const NAME_MAX_LENGTH = 255

// --- API selector shapes (POST/PATCH /cloud-security/entities/cloud-groups/v1)

/** One per-cloud scoping selector, as the Cloud Groups write API expects it. */
export interface CloudResourceSelector {
  cloud_provider: string
  account_ids?: string[]
  filters?: { region?: string[]; tags?: string[] }
}

/** One container-image scoping selector. Image filter keys are singular. */
export interface ImageSelector {
  registry: string
  filters?: { repository?: string[]; tag?: string[] }
}

/** The `selectors` object carried on a cloud group's create/update body. */
export interface CloudGroupSelectors {
  cloud_resources?: CloudResourceSelector[]
  images?: ImageSelector[]
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface CloudGroupSpec {
  sectionName: string
  name: string
  description?: string
  businessImpact: string
  businessUnit?: string
  environment: string
  owners: string[]
  /** Raw scoping JSON text as entered (empty string when none). */
  scopingRaw: string
}

/** Each canvas section describes one cloud group. */
export function extractCloudGroupSpecs(canvas: CanvasSnapshot): CloudGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      businessImpact:
        typeof fields.businessImpact === 'string' ? fields.businessImpact.trim().toLowerCase() : '',
      businessUnit:
        typeof fields.businessUnit === 'string' && fields.businessUnit.trim()
          ? fields.businessUnit.trim()
          : undefined,
      environment:
        typeof fields.environment === 'string' ? fields.environment.trim().toLowerCase() : '',
      owners: splitList(fields.owners),
      scopingRaw: typeof fields.scoping === 'string' ? fields.scoping.trim() : '',
    }
  })
}

// --- Scoping JSON parsing + selector building --------------------------------

export interface ScopingResult {
  /** Normalized API selectors, or undefined when the scope is empty/unparseable. */
  selectors?: CloudGroupSelectors
  /** Set when scopingRaw is non-empty but does not parse to a JSON object. */
  error?: string
  /** True when a GCP block declared tag filters (unsupported by the API). */
  gcpTagsDeclared?: boolean
  /** True when an image entry is missing its required `registry`. */
  imageMissingRegistry?: boolean
}

/** Pull a string list off a scoping object under any of the given key aliases. */
function pickList(source: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    if (key in source) return splitList(source[key])
  }
  return []
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse and normalize the user's scoping JSON into the API `selectors` shape.
 * Tolerates both friendly keys (accountIds/regions/tags, images:[{registry,
 * repositories,tags}]) and the API-native keys (account_ids/region, image
 * repository/tag). GCP tag filters are dropped (the API rejects them) and
 * flagged so validate can surface an error.
 */
export function parseScoping(raw: string): ScopingResult {
  if (!raw) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: 'Scoping must be valid JSON' }
  }
  if (!isPlainObject(parsed)) {
    return { error: 'Scoping must be a JSON object, e.g. {"aws": {"accountIds": ["..."]}}' }
  }

  const result: ScopingResult = {}
  const cloudResources: CloudResourceSelector[] = []

  for (const provider of CLOUD_PROVIDERS) {
    const block = parsed[provider]
    if (!isPlainObject(block)) continue

    const accountIds = pickList(block, 'accountIds', 'account_ids')
    const regions = pickList(block, 'regions', 'region')
    const tags = provider === 'gcp' ? [] : pickList(block, 'tags')
    if (provider === 'gcp' && pickList(block, 'tags').length > 0) {
      result.gcpTagsDeclared = true
    }

    const selector: CloudResourceSelector = { cloud_provider: provider }
    if (accountIds.length > 0) selector.account_ids = accountIds
    const filters: { region?: string[]; tags?: string[] } = {}
    if (regions.length > 0) filters.region = regions
    if (tags.length > 0) filters.tags = tags
    if (filters.region || filters.tags) selector.filters = filters
    cloudResources.push(selector)
  }

  const images: ImageSelector[] = []
  const rawImages = parsed.images
  if (Array.isArray(rawImages)) {
    for (const entry of rawImages) {
      if (!isPlainObject(entry)) continue
      const registry = typeof entry.registry === 'string' ? entry.registry.trim() : ''
      if (!registry) {
        result.imageMissingRegistry = true
        continue
      }
      const repository = pickList(entry, 'repositories', 'repository')
      const tag = pickList(entry, 'tags', 'tag')
      const image: ImageSelector = { registry }
      const filters: { repository?: string[]; tag?: string[] } = {}
      if (repository.length > 0) filters.repository = repository
      if (tag.length > 0) filters.tag = tag
      if (filters.repository || filters.tag) image.filters = filters
      images.push(image)
    }
  }

  const selectors: CloudGroupSelectors = {}
  if (cloudResources.length > 0) selectors.cloud_resources = cloudResources
  if (images.length > 0) selectors.images = images
  if (selectors.cloud_resources || selectors.images) result.selectors = selectors
  return result
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate cloud group configurations against Cloud Groups API constraints:
 * a unique name, recognized business-impact and environment tags, GCP scoping
 * without tag filters, image scope with a registry, and parseable scoping JSON.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCloudGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group name is required', code: 'required' })
    } else {
      if (spec.name.length > NAME_MAX_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Group name must be ${NAME_MAX_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate group "${spec.name}" — each group name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    // business_impact
    if (!spec.businessImpact) {
      errors.push({ field: `${prefix}.businessImpact`, message: 'Business impact is required', code: 'required' })
    } else if (!(BUSINESS_IMPACTS as readonly string[]).includes(spec.businessImpact)) {
      errors.push({
        field: `${prefix}.businessImpact`,
        message: `Business impact must be one of: ${BUSINESS_IMPACTS.join(', ')}`,
        code: 'invalid_business_impact',
      })
    }

    // environment
    if (!spec.environment) {
      errors.push({ field: `${prefix}.environment`, message: 'Environment is required', code: 'required' })
    } else if (!(ENVIRONMENTS as readonly string[]).includes(spec.environment)) {
      errors.push({
        field: `${prefix}.environment`,
        message: `Environment must be one of: ${ENVIRONMENTS.join(', ')}`,
        code: 'invalid_environment',
      })
    }

    // scoping JSON
    if (spec.scopingRaw) {
      const scope = parseScoping(spec.scopingRaw)
      if (scope.error) {
        errors.push({
          field: `${prefix}.scoping`,
          message: scope.error,
          code: 'invalid_scoping',
        })
      } else {
        if (scope.gcpTagsDeclared) {
          errors.push({
            field: `${prefix}.scoping`,
            message: 'GCP scoping does not support tag filters — remove "tags" from the gcp block',
            code: 'gcp_tags_unsupported',
          })
        }
        if (scope.imageMissingRegistry) {
          errors.push({
            field: `${prefix}.scoping`,
            message: 'Every image scope entry requires a "registry"',
            code: 'invalid_image',
          })
        }
        if (!scope.selectors) {
          warnings.push({
            field: `${prefix}.scoping`,
            message: 'Scoping produced no cloud or image selectors — the group will have no scope filters',
            code: 'empty_scope',
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
