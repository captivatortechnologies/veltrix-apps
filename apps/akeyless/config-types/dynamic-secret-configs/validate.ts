import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { toStringList } from '../../lib/akeyless'

// --- Akeyless Dynamic Secrets API constraints ----------------------------------
// https://docs.akeyless.io
//   POST /dynamic-secret-create-postgresql|aws|k8s
//   POST /dynamic-secret-update-postgresql|aws|k8s
//   POST /dynamic-secret-delete, /dynamic-secret-get, /dynamic-secret-list
// Identity is the config's NAME; TYPE is fixed at creation (immutable).
// The PRODUCED credential value is fetched via a separate, out-of-scope
// endpoint (/dynamic-secret-get-value) - never touched by this app.

export const DYNAMIC_SECRET_TYPES = ['postgresql', 'aws', 'k8s'] as const
export type DynamicSecretType = (typeof DYNAMIC_SECRET_TYPES)[number]

export interface DynamicSecretSpec {
  sectionName: string
  name: string
  type: DynamicSecretType | ''
  targetName: string
  description: string
  deleteProtection: boolean
  userTtl: string
  tags: string[]
  itemCustomFields: Record<string, string>
  // postgresql
  postgresqlHost: string
  postgresqlPort: string
  postgresqlDbName: string
  postgresqlUsername: string
  postgresqlPassword: string
  ssl: boolean
  passwordLengthPostgresql: string
  creationStatements: string
  revocationStatements: string
  // aws
  accessMode: string
  awsAccessKeyId: string
  awsAccessSecretKey: string
  region: string
  awsUserPolicies: string[]
  awsUserGroups: string[]
  awsRoleArns: string[]
  awsExternalId: string
  enableAdminRotation: boolean
  adminRotationIntervalDays: string
  passwordLengthAws: string
  // k8s
  k8sClusterEndpoint: string
  k8sClusterCaCert: string
  k8sClusterToken: string
  k8sClusterName: string
  k8sNamespace: string
  k8sServiceAccount: string
  useGwServiceAccount: boolean
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
function bool(v: unknown): boolean {
  return v === true || v === 'true'
}
function keyValue(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = str(val)
  return out
}

/** Each canvas item describes one Akeyless dynamic secret producer config. */
export function extractDynamicSecretSpecs(canvas: CanvasSnapshot): DynamicSecretSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const f = (section.fields ?? {}) as Record<string, unknown>
    return {
      sectionName: section.name,
      name: str(f.name),
      type: (DYNAMIC_SECRET_TYPES as readonly string[]).includes(str(f.type)) ? (str(f.type) as DynamicSecretType) : '',
      targetName: str(f.targetName),
      description: str(f.description),
      deleteProtection: bool(f.deleteProtection),
      userTtl: str(f.userTtl) || '60m',
      tags: toStringList(f.tags),
      itemCustomFields: keyValue(f.itemCustomFields),
      postgresqlHost: str(f.postgresqlHost) || '127.0.0.1',
      postgresqlPort: str(f.postgresqlPort) || '5432',
      postgresqlDbName: str(f.postgresqlDbName),
      postgresqlUsername: str(f.postgresqlUsername),
      postgresqlPassword: str(f.postgresqlPassword),
      ssl: bool(f.ssl),
      passwordLengthPostgresql: str(f.passwordLengthPostgresql),
      creationStatements: str(f.creationStatements),
      revocationStatements: str(f.revocationStatements),
      accessMode: str(f.accessMode) || 'iam_user',
      awsAccessKeyId: str(f.awsAccessKeyId),
      awsAccessSecretKey: str(f.awsAccessSecretKey),
      region: str(f.region) || 'us-east-2',
      awsUserPolicies: toStringList(f.awsUserPolicies),
      awsUserGroups: toStringList(f.awsUserGroups),
      awsRoleArns: toStringList(f.awsRoleArns),
      awsExternalId: str(f.awsExternalId),
      enableAdminRotation: bool(f.enableAdminRotation),
      adminRotationIntervalDays: str(f.adminRotationIntervalDays),
      passwordLengthAws: str(f.passwordLengthAws),
      k8sClusterEndpoint: str(f.k8sClusterEndpoint),
      k8sClusterCaCert: str(f.k8sClusterCaCert),
      k8sClusterToken: str(f.k8sClusterToken),
      k8sClusterName: str(f.k8sClusterName),
      k8sNamespace: str(f.k8sNamespace) || 'default',
      k8sServiceAccount: str(f.k8sServiceAccount),
      useGwServiceAccount: bool(f.useGwServiceAccount),
    }
  })
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDynamicSecretSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate dynamic secret config "${spec.name}"`, code: 'duplicate_name' })
    }
    if (spec.name) seenNames.add(spec.name)

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: `Type is required and must be one of: ${DYNAMIC_SECRET_TYPES.join(', ')}`, code: 'required' })
      continue
    }

    const hasTarget = Boolean(spec.targetName)
    if (spec.type === 'postgresql' && !hasTarget && !spec.postgresqlPassword) {
      warnings.push({
        field: `${prefix}.postgresqlPassword`,
        message: 'No Target and no Admin Password set - deploy will fail unless this producer already exists with credentials stored.',
        code: 'missing_credentials',
      })
    }
    if (spec.type === 'aws' && !hasTarget && !spec.awsAccessSecretKey) {
      warnings.push({
        field: `${prefix}.awsAccessSecretKey`,
        message: 'No Target and no Admin Secret Access Key set - deploy will fail unless this producer already exists with credentials stored.',
        code: 'missing_credentials',
      })
    }
    if (spec.type === 'aws' && !['iam_user', 'assume_role'].includes(spec.accessMode)) {
      errors.push({ field: `${prefix}.accessMode`, message: 'Access Mode must be "iam_user" or "assume_role"', code: 'invalid_value' })
    }
    if (spec.type === 'k8s' && !hasTarget && !spec.k8sClusterEndpoint) {
      errors.push({
        field: `${prefix}.k8sClusterEndpoint`,
        message: 'Cluster Endpoint URL is required for a Kubernetes producer with no Target',
        code: 'required',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
