import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Akeyless Targets API constraints ------------------------------------------
// https://docs.akeyless.io
//   POST /target-create-db|aws|k8s, /target-update-db|aws|k8s, /target-delete,
//   /target-get-details, /target-list
// A target's identity is its NAME; TYPE is fixed at creation (immutable).

export const TARGET_TYPES = ['db', 'aws', 'k8s'] as const
export type TargetType = (typeof TARGET_TYPES)[number]
export const DB_TYPES = ['mysql', 'postgres', 'mssql', 'mongodb', 'snowflake', 'oracle', 'cassandra', 'redshift'] as const

export interface TargetSpec {
  sectionName: string
  name: string
  type: TargetType | ''
  description: string
  deleteProtection: boolean
  maxVersions: string
  // db
  dbType: string
  connectionType: string
  host: string
  port: string
  dbName: string
  userName: string
  pwd: string
  ssl: boolean
  sslCertificate: string
  dbServerCertificates: string
  dbServerName: string
  enableMtls: boolean
  clientCertificate: string
  clientPrivateKey: string
  clientKeyPassphrase: string
  // aws
  accessKeyId: string
  accessKey: string
  sessionToken: string
  region: string
  useGwCloudIdentity: boolean
  generateExternalId: boolean
  roleArn: string
  // k8s
  k8sClusterEndpoint: string
  k8sClusterCaCert: string
  k8sClusterToken: string
  k8sAuthType: string
  k8sClientCertificate: string
  k8sClientKey: string
  k8sClusterName: string
  useGwServiceAccount: boolean
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
function bool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Each canvas item describes one Akeyless target. */
export function extractTargetSpecs(canvas: CanvasSnapshot): TargetSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const f = (section.fields ?? {}) as Record<string, unknown>
    return {
      sectionName: section.name,
      name: str(f.name),
      type: (TARGET_TYPES as readonly string[]).includes(str(f.type)) ? (str(f.type) as TargetType) : '',
      description: str(f.description),
      deleteProtection: bool(f.deleteProtection),
      maxVersions: str(f.maxVersions),
      dbType: str(f.dbType),
      connectionType: str(f.connectionType) || 'credentials',
      host: str(f.host),
      port: str(f.port),
      dbName: str(f.dbName),
      userName: str(f.userName),
      pwd: str(f.pwd),
      ssl: bool(f.ssl),
      sslCertificate: str(f.sslCertificate),
      dbServerCertificates: str(f.dbServerCertificates),
      dbServerName: str(f.dbServerName),
      enableMtls: bool(f.enableMtls),
      clientCertificate: str(f.clientCertificate),
      clientPrivateKey: str(f.clientPrivateKey),
      clientKeyPassphrase: str(f.clientKeyPassphrase),
      accessKeyId: str(f.accessKeyId),
      accessKey: str(f.accessKey),
      sessionToken: str(f.sessionToken),
      region: str(f.region) || 'us-east-2',
      useGwCloudIdentity: bool(f.useGwCloudIdentity),
      generateExternalId: bool(f.generateExternalId),
      roleArn: str(f.roleArn),
      k8sClusterEndpoint: str(f.k8sClusterEndpoint),
      k8sClusterCaCert: str(f.k8sClusterCaCert),
      k8sClusterToken: str(f.k8sClusterToken),
      k8sAuthType: str(f.k8sAuthType) || 'token',
      k8sClientCertificate: str(f.k8sClientCertificate),
      k8sClientKey: str(f.k8sClientKey),
      k8sClusterName: str(f.k8sClusterName),
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

  const specs = extractTargetSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate target "${spec.name}"`, code: 'duplicate_name' })
    }
    if (spec.name) seenNames.add(spec.name)

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: `Type is required and must be one of: ${TARGET_TYPES.join(', ')}`, code: 'required' })
      continue
    }

    if (spec.type === 'db') {
      if (!spec.dbType) {
        errors.push({ field: `${prefix}.dbType`, message: 'Database Type is required for a Database target', code: 'required' })
      } else if (!(DB_TYPES as readonly string[]).includes(spec.dbType)) {
        errors.push({ field: `${prefix}.dbType`, message: `Database Type must be one of: ${DB_TYPES.join(', ')}`, code: 'invalid_value' })
      }
      if (!['credentials', 'cloud-identity'].includes(spec.connectionType)) {
        errors.push({
          field: `${prefix}.connectionType`,
          message: 'Connection Type must be "credentials" or "cloud-identity" (see canvas help text)',
          code: 'invalid_value',
        })
      }
    }

    if (spec.type === 'aws') {
      if (!spec.accessKeyId) {
        errors.push({ field: `${prefix}.accessKeyId`, message: 'Access Key ID is required for an AWS target', code: 'required' })
      }
    }

    if (spec.type === 'k8s') {
      if (!spec.k8sClusterEndpoint) {
        errors.push({ field: `${prefix}.k8sClusterEndpoint`, message: 'Cluster Endpoint URL is required for a Kubernetes target', code: 'required' })
      }
      if (!['token', 'certificate'].includes(spec.k8sAuthType)) {
        errors.push({ field: `${prefix}.k8sAuthType`, message: 'Auth Type must be "token" or "certificate"', code: 'invalid_value' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
