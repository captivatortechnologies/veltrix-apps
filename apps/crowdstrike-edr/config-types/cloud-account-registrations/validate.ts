import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'

// --- CSPM Registration API constraints ---------------------------------------

export const CLOUD_PROVIDERS = ['aws', 'azure', 'gcp'] as const
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number]

export const ACCOUNT_TYPES = ['commercial', 'gov'] as const

const AWS_ACCOUNT_ID_RE = /^\d{12}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// GCP project IDs: 6–30 chars, lowercase letter first, letters/digits/hyphens, no trailing hyphen.
const GCP_PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface AccountSpec {
  sectionName: string
  cloudProvider: string
  accountType: string
  /** AWS */
  accountId?: string
  iamRoleArn?: string
  /** Azure */
  subscriptionId?: string
  tenantId?: string
  defaultSubscription: boolean
  /** GCP */
  projectId?: string
  /** Falcon capability flags. cspmEnabled is the base registration and is not sent to the API. */
  cspmEnabled: boolean
  behaviorAssessmentEnabled: boolean
  sensorManagementEnabled: boolean
  dspmEnabled: boolean
  regions: string[]
}

/** Shape of an account returned by GET /cloud-connect-cspm-{aws,azure,gcp}/entities/account/v1. */
export interface LiveAccount {
  account_id?: string
  subscription_id?: string
  tenant_id?: string
  project_id?: string
  parent_id?: string
  parent_type?: string
  account_type?: string
  iam_role_arn?: string
  cloudtrail_region?: string
  default_subscription?: boolean
  behavior_assessment_enabled?: boolean
  sensor_management_enabled?: boolean
  dspm_enabled?: boolean
  status?: string
  /**
   * Best-effort modifier fields for drift attribution. CSPM account resources
   * are NOT verified to carry these, so attribution is typically empty — but
   * they are declared so the resource satisfies the audit helper's shape.
   */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** The provider id that identifies this account in Falcon (used for find / delete). */
export function accountIdentity(spec: AccountSpec): string {
  switch (spec.cloudProvider) {
    case 'aws':
      return spec.accountId ?? ''
    case 'azure':
      return spec.subscriptionId ?? ''
    case 'gcp':
      return spec.projectId ?? ''
    default:
      return ''
  }
}

/** The provider id read back off a live account resource. */
export function liveAccountIdentity(provider: string, live: LiveAccount): string {
  switch (provider) {
    case 'aws':
      return live.account_id ?? ''
    case 'azure':
      return live.subscription_id ?? ''
    case 'gcp':
      return live.parent_id ?? live.project_id ?? ''
    default:
      return ''
  }
}

/** Each canvas section describes one cloud account registration. */
export function extractAccountSpecs(canvas: CanvasSnapshot): AccountSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (key: string): string | undefined => {
      const value = typeof fields[key] === 'string' ? (fields[key] as string).trim() : ''
      return value.length > 0 ? value : undefined
    }

    return {
      sectionName: section.name,
      cloudProvider:
        typeof fields.cloudProvider === 'string' ? fields.cloudProvider.trim().toLowerCase() : '',
      accountType:
        typeof fields.accountType === 'string' && fields.accountType.trim()
          ? fields.accountType.trim().toLowerCase()
          : 'commercial',
      // AWS account ids are digits; Azure/GCP ids are lowercased for stable identity matching.
      accountId: str('accountId'),
      iamRoleArn: str('iamRoleArn'),
      subscriptionId: str('subscriptionId')?.toLowerCase(),
      tenantId: str('tenantId')?.toLowerCase(),
      defaultSubscription: coerceBoolean(fields.defaultSubscription, false),
      projectId: str('projectId')?.toLowerCase(),
      cspmEnabled: coerceBoolean(fields.cspmEnabled, true),
      behaviorAssessmentEnabled: coerceBoolean(fields.behaviorAssessmentEnabled, false),
      sensorManagementEnabled: coerceBoolean(fields.sensorManagementEnabled, false),
      dspmEnabled: coerceBoolean(fields.dspmEnabled, false),
      regions: splitList(fields.regions),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate cloud account registrations against CSPM Registration API
 * constraints: provider, the correct id(s) per provider, account type, and
 * provider-scoped field usage. Also warns that registration alone does not
 * finish onboarding — the setup CloudFormation/ARM/Terraform must be run
 * out-of-band in the customer's cloud.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAccountSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // provider
    if (!spec.cloudProvider) {
      errors.push({ field: `${prefix}.cloudProvider`, message: 'Cloud provider is required', code: 'required' })
    } else if (!(CLOUD_PROVIDERS as readonly string[]).includes(spec.cloudProvider)) {
      errors.push({
        field: `${prefix}.cloudProvider`,
        message: `Cloud provider must be one of: ${CLOUD_PROVIDERS.join(', ')}`,
        code: 'invalid_provider',
      })
    } else {
      validateProviderFields(spec, prefix, errors, warnings)

      // duplicate provider + identity
      const identity = accountIdentity(spec)
      if (identity) {
        const key = `${spec.cloudProvider}:${identity}`
        if (seen.has(key)) {
          errors.push({
            field: `${prefix}.cloudProvider`,
            message: `Duplicate ${spec.cloudProvider} account "${identity}" — each account may only be declared once per canvas`,
            code: 'duplicate_account',
          })
        }
        seen.add(key)
      }
    }

    // account type
    if (!(ACCOUNT_TYPES as readonly string[]).includes(spec.accountType)) {
      errors.push({
        field: `${prefix}.accountType`,
        message: `Account type must be one of: ${ACCOUNT_TYPES.join(', ')}`,
        code: 'invalid_account_type',
      })
    }

    // CSPM is the base registration capability — it cannot be turned off here.
    if (!spec.cspmEnabled) {
      warnings.push({
        field: `${prefix}.cspmEnabled`,
        message:
          'CSPM is the base registration capability and stays on while the account is registered. Unchecking does not deregister — delete the item to remove the account.',
        code: 'cspm_base_capability',
      })
    }

    // The registration is not live until the customer runs the setup scripts.
    warnings.push({
      field: `${prefix}.cloudProvider`,
      message:
        'Registering the account does not finish onboarding — run the setup CloudFormation/ARM/Terraform that Falcon returns in the target cloud (out-of-band) before assessment goes live.',
      code: 'requires_out_of_band_setup',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Per-provider identity and field checks. */
function validateProviderFields(
  spec: AccountSpec,
  prefix: string,
  errors: ValidationResult['errors'],
  warnings: ValidationResult['warnings'],
): void {
  if (spec.cloudProvider === 'aws') {
    if (!spec.accountId) {
      errors.push({ field: `${prefix}.accountId`, message: 'AWS account ID is required', code: 'required' })
    } else if (!AWS_ACCOUNT_ID_RE.test(spec.accountId)) {
      errors.push({
        field: `${prefix}.accountId`,
        message: 'AWS account ID must be exactly 12 digits',
        code: 'invalid_format',
      })
    }
    if (!spec.iamRoleArn) {
      warnings.push({
        field: `${prefix}.iamRoleArn`,
        message:
          'No IAM role ARN set — Falcon usually creates it via the setup CloudFormation. Add it once the role exists so drift detection can track it.',
        code: 'missing_iam_role',
      })
    }
    warnForForeignFields(spec, ['azure', 'gcp'], prefix, warnings)
  } else if (spec.cloudProvider === 'azure') {
    if (!spec.subscriptionId) {
      errors.push({
        field: `${prefix}.subscriptionId`,
        message: 'Azure subscription ID is required',
        code: 'required',
      })
    } else if (!UUID_RE.test(spec.subscriptionId)) {
      errors.push({
        field: `${prefix}.subscriptionId`,
        message: 'Azure subscription ID must be a GUID, e.g. 00000000-0000-0000-0000-000000000000',
        code: 'invalid_format',
      })
    }
    if (!spec.tenantId) {
      errors.push({ field: `${prefix}.tenantId`, message: 'Azure tenant ID is required', code: 'required' })
    } else if (!UUID_RE.test(spec.tenantId)) {
      errors.push({
        field: `${prefix}.tenantId`,
        message: 'Azure tenant ID must be a GUID, e.g. 00000000-0000-0000-0000-000000000000',
        code: 'invalid_format',
      })
    }
    warnForForeignFields(spec, ['aws', 'gcp'], prefix, warnings)
  } else if (spec.cloudProvider === 'gcp') {
    if (!spec.projectId) {
      errors.push({ field: `${prefix}.projectId`, message: 'GCP project ID is required', code: 'required' })
    } else if (!GCP_PROJECT_ID_RE.test(spec.projectId)) {
      errors.push({
        field: `${prefix}.projectId`,
        message: 'GCP project ID must be 6–30 characters: a lowercase letter, then letters, digits or hyphens',
        code: 'invalid_format',
      })
    }
    warnForForeignFields(spec, ['aws', 'azure'], prefix, warnings)
  }
}

/** Warn when fields belonging to another provider are populated (they are ignored). */
function warnForForeignFields(
  spec: AccountSpec,
  foreign: CloudProvider[],
  prefix: string,
  warnings: ValidationResult['warnings'],
): void {
  const foreignSet = new Set(foreign)
  const checks: Array<{ owner: CloudProvider; field: string; set: boolean }> = [
    { owner: 'aws', field: 'accountId', set: !!spec.accountId },
    { owner: 'aws', field: 'iamRoleArn', set: !!spec.iamRoleArn },
    { owner: 'aws', field: 'regions', set: spec.regions.length > 0 },
    { owner: 'azure', field: 'subscriptionId', set: !!spec.subscriptionId },
    { owner: 'azure', field: 'tenantId', set: !!spec.tenantId },
    { owner: 'gcp', field: 'projectId', set: !!spec.projectId },
  ]
  for (const check of checks) {
    if (foreignSet.has(check.owner) && check.set) {
      warnings.push({
        field: `${prefix}.${check.field}`,
        message: `"${check.field}" applies to ${check.owner.toUpperCase()} accounts and is ignored for ${spec.cloudProvider.toUpperCase()}`,
        code: 'field_ignored',
      })
    }
  }
}
