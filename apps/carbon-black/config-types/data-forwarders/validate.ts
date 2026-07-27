import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black data forwarder constraints ---------------------------------

/** The event stream a forwarder ships. Immutable after create. */
export const FORWARDER_TYPES = ['alert', 'auditlog', 'auth.event', 'endpoint.event', 'livequery', 'watchlist.hit'] as const
/** The cloud-storage destination a forwarder writes to. Immutable after create. */
export const DESTINATIONS = ['aws_s3', 'azure_blob_storage', 'gcs_bucket'] as const

export interface ForwarderSpec {
  itemId?: string
  /** name — the forwarder's identity (forwarders are id-addressed; matched by name). */
  name: string
  type: string
  destination: string
  enabled: boolean
  versionConstraint: string
  s3BucketName: string
  s3Prefix: string
  azureStorageAccount: string
  azureContainerName: string
  azureTenantId: string
  azureClientId: string
  gcsBucketName: string
  gcsPrefix: string
}

/** A forwarder config as returned by the data-forwarder service. */
export interface LiveForwarder {
  id?: string
  name?: string
  type?: string
  destination?: string
  enabled?: boolean
  version_constraint?: string
  s3_bucket_name?: string
  s3_prefix?: string
  azure_storage_account?: string
  azure_container_name?: string
  azure_tenant_id?: string
  azure_client_id?: string
  gcs_bucket_name?: string
  gcs_prefix?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractForwarderSpecs(canvas: CanvasSnapshot): ForwarderSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: (asString(f.type) || 'alert').toLowerCase(),
      destination: (asString(f.destination) || 'aws_s3').toLowerCase(),
      enabled: f.enabled === undefined ? true : asBool(f.enabled),
      versionConstraint: asString(f.versionConstraint),
      s3BucketName: asString(f.s3BucketName),
      s3Prefix: asString(f.s3Prefix),
      azureStorageAccount: asString(f.azureStorageAccount),
      azureContainerName: asString(f.azureContainerName),
      azureTenantId: asString(f.azureTenantId),
      azureClientId: asString(f.azureClientId),
      gcsBucketName: asString(f.gcsBucketName),
      gcsPrefix: asString(f.gcsPrefix),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractForwarderSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) errors.push({ field: `${prefix}.name`, message: `Duplicate forwarder "${spec.name}"`, code: 'duplicate_name' })
      seen.add(key)
    }

    if (!(FORWARDER_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of: ${FORWARDER_TYPES.join(', ')}`, code: 'invalid_type' })
    }
    if (!(DESTINATIONS as readonly string[]).includes(spec.destination)) {
      errors.push({ field: `${prefix}.destination`, message: `Destination must be one of: ${DESTINATIONS.join(', ')}`, code: 'invalid_destination' })
      return
    }

    // destination-conditional required fields
    if (spec.destination === 'aws_s3') {
      if (!spec.s3BucketName) errors.push({ field: `${prefix}.s3BucketName`, message: 'An S3 forwarder needs a bucket name', code: 'missing_bucket' })
    } else if (spec.destination === 'azure_blob_storage') {
      if (!spec.azureStorageAccount) errors.push({ field: `${prefix}.azureStorageAccount`, message: 'An Azure forwarder needs a storage account', code: 'missing_storage_account' })
      if (!spec.azureContainerName) errors.push({ field: `${prefix}.azureContainerName`, message: 'An Azure forwarder needs a container name', code: 'missing_container' })
    } else if (spec.destination === 'gcs_bucket') {
      if (!spec.gcsBucketName) errors.push({ field: `${prefix}.gcsBucketName`, message: 'A GCS forwarder needs a bucket name', code: 'missing_bucket' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
