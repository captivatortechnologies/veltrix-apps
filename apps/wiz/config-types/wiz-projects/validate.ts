import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Wiz project constraints --------------------------------------------------

export const BUSINESS_IMPACTS = ['LBI', 'MBI', 'HBI'] as const
export const YES_NO_UNKNOWN = ['YES', 'NO', 'UNKNOWN'] as const
export const SENSITIVE_DATA_TYPES = ['CLASSIFIED', 'HEALTH', 'PII', 'PCI', 'FINANCIAL', 'CUSTOMER'] as const
export const REGULATORY_STANDARDS = [
  'ISO_20000_1_2011',
  'ISO_22301',
  'ISO_27001',
  'ISO_27017',
  'ISO_27018',
  'ISO_27701',
  'ISO_9001',
  'SOC',
  'FEDRAMP',
  'NIST_800_171',
  'NIST_CSF',
  'HIPPA_HITECH',
  'HITRUST',
  'PCI_DSS',
  'SEC_17A_4',
  'SEC_REGULATION_SCI',
  'SOX',
  'GDPR',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RiskProfileSpec {
  businessImpact: string
  hasAuthentication: string
  hasExposedApi: string
  isInternetFacing: string
  isCustomerFacing: string
  storesData: string
  isRegulated: string
  isActivelyDeveloped: string
  sensitiveDataTypes: string[]
  regulatoryStandards: string[]
}

export interface ProjectSpec {
  sectionName: string
  name: string
  description: string
  businessUnit: string
  isFolder: boolean
  parentProjectId: string
  archived: boolean
  identifiers: string[]
  projectOwners: string[]
  securityChampions: string[]
  riskProfile: RiskProfileSpec
  /** Raw resource-links JSON as typed by the user (validated separately). */
  resourceLinksText: string
  /** Parsed resource-links value — undefined when blank or malformed. */
  resourceLinks: unknown
}

/** A project as returned by the `projects` list query. */
export interface LiveProject {
  id?: string
  name?: string
}

/** A project as returned by the single-project read query (full managed state). */
export interface FullProject {
  id?: string
  name?: string
  description?: string
  businessUnit?: string
  isFolder?: boolean
  archived?: boolean
  parentProjectId?: string
  identifiers?: string[]
  projectOwners?: Array<{ id?: string }>
  securityChampions?: Array<{ id?: string }>
  riskProfile?: {
    businessImpact?: string
    isActivelyDeveloped?: string
    hasAuthentication?: string
    hasExposedAPI?: string
    isInternetFacing?: string
    isCustomerFacing?: string
    storesData?: string
    isRegulated?: string
    sensitiveDataTypes?: string[]
    regulatoryStandards?: string[]
  }
  cloudAccountLinks?: Array<{
    cloudAccount?: { id?: string }
    environment?: string
    shared?: boolean
    resourceGroups?: string[]
    resourceTags?: Array<{ key?: string; value?: string }>
  }>
  cloudOrganizationLinks?: Array<{
    cloudOrganization?: { id?: string }
    environment?: string
    shared?: boolean
    resourceGroups?: string[]
    resourceTags?: Array<{ key?: string; value?: string }>
  }>
  kubernetesClustersLinks?: Array<{
    kubernetesCluster?: { id?: string }
    environment?: string
    shared?: boolean
    namespaces?: string[]
  }>
  slug?: string
}

/** The project's logical identity: its name (case-insensitive, trimmed). */
export function projectKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a canvas value that may be a `tags`/`multiselect` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Try to parse JSON text; empty text is treated as absent (ok, undefined value). */
export function tryParseJson(text: string): { value: unknown; ok: boolean } {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    return { value: JSON.parse(trimmed), ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

/** True when a value is a non-null, non-array JSON object. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Each canvas item describes one Wiz project. */
export function extractProjectSpecs(canvas: CanvasSnapshot): ProjectSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const resourceLinksText = str(fields.resource_links_json)
    const parsedLinks = tryParseJson(resourceLinksText)
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      businessUnit: str(fields.business_unit),
      isFolder: readBool(fields.is_folder, false),
      parentProjectId: str(fields.parent_project_id),
      archived: readBool(fields.archived, false),
      identifiers: strList(fields.identifiers),
      projectOwners: strList(fields.project_owners),
      securityChampions: strList(fields.security_champions),
      riskProfile: {
        businessImpact: str(fields.risk_business_impact) || 'MBI',
        hasAuthentication: str(fields.risk_has_authentication) || 'UNKNOWN',
        hasExposedApi: str(fields.risk_has_exposed_api) || 'UNKNOWN',
        isInternetFacing: str(fields.risk_is_internet_facing) || 'UNKNOWN',
        isCustomerFacing: str(fields.risk_is_customer_facing) || 'UNKNOWN',
        storesData: str(fields.risk_stores_data) || 'UNKNOWN',
        isRegulated: str(fields.risk_is_regulated) || 'UNKNOWN',
        isActivelyDeveloped: str(fields.risk_is_actively_developed) || 'UNKNOWN',
        sensitiveDataTypes: strList(fields.risk_sensitive_data_types),
        regulatoryStandards: strList(fields.risk_regulatory_standards),
      },
      resourceLinksText,
      resourceLinks: parsedLinks.ok ? parsedLinks.value : undefined,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Wiz project configurations: name is required and unique across the
 * canvas (case-insensitive); risk-profile enum fields must be supported
 * values; and resource links (when present) must be a JSON object whose
 * `cloudAccountLinks` / `cloudOrganizationLinks` / `kubernetesClusterLinks`
 * (each optional) are arrays.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractProjectSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Project name is required', code: 'required' })
    }

    const rp = spec.riskProfile
    checkEnum(errors, `${prefix}.risk_business_impact`, rp.businessImpact, BUSINESS_IMPACTS)
    checkEnum(errors, `${prefix}.risk_has_authentication`, rp.hasAuthentication, YES_NO_UNKNOWN)
    checkEnum(errors, `${prefix}.risk_has_exposed_api`, rp.hasExposedApi, YES_NO_UNKNOWN)
    checkEnum(errors, `${prefix}.risk_is_internet_facing`, rp.isInternetFacing, YES_NO_UNKNOWN)
    checkEnum(errors, `${prefix}.risk_is_customer_facing`, rp.isCustomerFacing, YES_NO_UNKNOWN)
    checkEnum(errors, `${prefix}.risk_stores_data`, rp.storesData, YES_NO_UNKNOWN)
    checkEnum(errors, `${prefix}.risk_is_regulated`, rp.isRegulated, YES_NO_UNKNOWN)
    checkEnum(errors, `${prefix}.risk_is_actively_developed`, rp.isActivelyDeveloped, YES_NO_UNKNOWN)
    for (const v of rp.sensitiveDataTypes) checkEnum(errors, `${prefix}.risk_sensitive_data_types`, v, SENSITIVE_DATA_TYPES)
    for (const v of rp.regulatoryStandards) checkEnum(errors, `${prefix}.risk_regulatory_standards`, v, REGULATORY_STANDARDS)

    if (spec.resourceLinksText) {
      if (spec.resourceLinks === undefined) {
        errors.push({ field: `${prefix}.resource_links_json`, message: 'Resource links must be valid JSON', code: 'invalid_json' })
      } else if (!isJsonObject(spec.resourceLinks)) {
        errors.push({ field: `${prefix}.resource_links_json`, message: 'Resource links must be a JSON object', code: 'invalid_links' })
      } else {
        for (const key of ['cloudAccountLinks', 'cloudOrganizationLinks', 'kubernetesClusterLinks']) {
          const value = (spec.resourceLinks as Record<string, unknown>)[key]
          if (value !== undefined && !Array.isArray(value)) {
            errors.push({ field: `${prefix}.resource_links_json.${key}`, message: `"${key}" must be an array`, code: 'invalid_links' })
          }
        }
      }
    }

    if (spec.name) {
      const key = projectKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate project "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_project',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function checkEnum(errors: ValidationResult['errors'], field: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) {
    errors.push({ field, message: `Unsupported value "${value}"`, code: 'invalid_enum_value' })
  }
}
