import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- DDSS self storage constraints (ACS cloud-resources/self-storage-locations)
//
// Dynamic Data Self Storage (DDSS) rolls frozen index buckets out to a customer
// -owned S3 (AWS) or GCS (GCP) bucket. A self storage LOCATION is registered
// globally on the stack, then an index references it (that per-index attachment
// is done by the `indexes` config type's `selfStorageBucketPath` field, not
// here). ACS create-only endpoint:
//   POST /adminconfig/v2/cloud-resources/self-storage-locations/buckets
//     body: { title, bucketName, folder?, description? }   (region is NOT a body
//            field — ACS derives it from the bucket, which MUST live in the same
//            region as the stack)
//   GET  /adminconfig/v2/cloud-resources/self-storage-locations/buckets
//     → { selfStorageLocations: [{ bucketName, bucketPath, title, description,
//         folder, uri }] }
// ACS does NOT support modifying or deleting self storage locations.
// Docs: help.splunk.com …/manage-ddss-self-storage-locations
// =============================================================================

/** ACS endpoint (relative to adminconfig/v2) for self storage locations. */
export const SELF_STORAGE_BUCKETS_PATH = '/cloud-resources/self-storage-locations/buckets'

/** S3/GCS bucket names are 3–63 characters. */
export const MIN_BUCKET_NAME_LENGTH = 3
export const MAX_BUCKET_NAME_LENGTH = 63

/** AWS S3: lowercase letters, numbers, dots, hyphens; begin/end alphanumeric. */
export const AWS_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/
/** GCP GCS: lowercase letters, numbers, dots, hyphens, underscores; begin/end alphanumeric. */
export const GCP_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/
/** A dotted IPv4 address — S3 forbids IP-formatted bucket names. */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
/** AWS region incl. GovCloud/ISO partitions, e.g. us-east-1, us-gov-west-1. */
export const AWS_REGION_RE = /^[a-z]{2}(-gov|-iso[ab]?)?-[a-z]+-\d$/
/** GCP region, e.g. us-central1, europe-west4. */
export const GCP_REGION_RE = /^[a-z]+-[a-z]+\d$/
/** Splunk index name (the target index this location is intended for). */
export const INDEX_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
/** AWS S3 "safe" object-key characters, applied to the folder/prefix. */
export const S3_FOLDER_RE = /^[a-zA-Z0-9!_.*'()/-]+$/

export type StorageProvider = 'aws' | 'gcp'

export interface SelfStorageSpec {
  sectionName: string
  title: string
  provider: StorageProvider
  bucketName: string
  folder: string
  description: string
  region: string
  targetIndex: string
}

/** Shape of one self storage location returned by ACS GET .../buckets. */
export interface LiveSelfStorageLocation {
  title?: string
  bucketName?: string
  bucketPath?: string
  folder?: string
  description?: string
  uri?: string
}

/** Trim a folder/prefix and strip surrounding slashes so keys match ACS. */
export function normalizeFolder(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : ''
}

/** Stable identity for a location — bucket + normalized folder. */
export function locationKey(bucketName: string, folder: unknown): string {
  return `${bucketName.trim()}::${normalizeFolder(folder)}`
}

/** Each canvas section describes one DDSS self storage location. */
export function extractSelfStorageSpecs(canvas: CanvasSnapshot): SelfStorageSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      title: typeof fields.title === 'string' ? fields.title.trim() : '',
      provider: fields.provider === 'gcp' ? 'gcp' : 'aws',
      bucketName: typeof fields.bucketName === 'string' ? fields.bucketName.trim() : '',
      folder: normalizeFolder(fields.folder),
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      region: typeof fields.region === 'string' ? fields.region.trim() : '',
      targetIndex: typeof fields.targetIndex === 'string' ? fields.targetIndex.trim() : '',
    }
  })
}

// --- Validate handler --------------------------------------------------------

/**
 * Validate DDSS self storage locations against ACS + cloud-provider constraints:
 * a title, a provider-valid bucket name (S3/GCS naming rules), an optional
 * folder/prefix, an optional region (informational — must match the stack), and
 * an optional target index the location is intended for. Warnings flag dotted
 * bucket names, region reminders, and how per-index attachment actually happens.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seenTitles = new Set<string>()
  const seenBuckets = new Set<string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name
    const provider: StorageProvider = fields.provider === 'gcp' ? 'gcp' : 'aws'

    // Title — the display name of the self storage location on the stack.
    const title = typeof fields.title === 'string' ? fields.title.trim() : ''
    if (!title) {
      errors.push({ field: `${prefix}.title`, message: 'Self storage location title is required', code: 'required' })
    } else {
      if (seenTitles.has(title)) {
        errors.push({
          field: `${prefix}.title`,
          message: `Duplicate self storage title "${title}" — each location must have a unique title`,
          code: 'duplicate_title',
        })
      }
      seenTitles.add(title)
    }

    // Bucket name — provider-specific naming rules.
    const bucketName = typeof fields.bucketName === 'string' ? fields.bucketName.trim() : ''
    if (!bucketName) {
      errors.push({ field: `${prefix}.bucketName`, message: 'S3/GCS bucket name is required', code: 'required' })
    } else {
      if (bucketName.length < MIN_BUCKET_NAME_LENGTH || bucketName.length > MAX_BUCKET_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.bucketName`,
          message: `Bucket name must be ${MIN_BUCKET_NAME_LENGTH}–${MAX_BUCKET_NAME_LENGTH} characters (got ${bucketName.length})`,
          code: 'bucket_name_length',
        })
      } else if (provider === 'gcp' ? !GCP_BUCKET_NAME_RE.test(bucketName) : !AWS_BUCKET_NAME_RE.test(bucketName)) {
        errors.push({
          field: `${prefix}.bucketName`,
          message:
            provider === 'gcp'
              ? 'GCS bucket name must be lowercase letters, numbers, dots, hyphens or underscores, and begin and end with a letter or number'
              : 'S3 bucket name must be lowercase letters, numbers, dots or hyphens, and begin and end with a letter or number',
          code: 'invalid_bucket_name',
        })
      } else if (provider === 'aws' && IPV4_RE.test(bucketName)) {
        errors.push({
          field: `${prefix}.bucketName`,
          message: `"${bucketName}" — S3 bucket names cannot be formatted as an IP address`,
          code: 'bucket_is_ip',
        })
      } else if (bucketName.includes('.')) {
        // Dotted names are legal but break virtual-hosted-style TLS — warn.
        warnings.push({
          field: `${prefix}.bucketName`,
          message: `"${bucketName}" contains dots — dotted bucket names break virtual-hosted-style TLS; hyphens are recommended`,
          code: 'bucket_dots',
        })
      }

      // Duplicate location = same bucket + same folder across sections.
      const key = locationKey(bucketName, fields.folder)
      if (seenBuckets.has(key)) {
        errors.push({
          field: `${prefix}.bucketName`,
          message: `Duplicate self storage location for bucket "${bucketName}"${
            normalizeFolder(fields.folder) ? `/${normalizeFolder(fields.folder)}` : ''
          } — declare each bucket+folder once`,
          code: 'duplicate_bucket',
        })
      }
      seenBuckets.add(key)
    }

    // Folder / prefix (optional).
    const rawFolder = typeof fields.folder === 'string' ? fields.folder : ''
    if (rawFolder.trim()) {
      if (rawFolder.trim().startsWith('/')) {
        errors.push({
          field: `${prefix}.folder`,
          message: 'Folder/prefix must not begin with "/" — give a path relative to the bucket root',
          code: 'invalid_folder',
        })
      } else if (!S3_FOLDER_RE.test(rawFolder.trim())) {
        errors.push({
          field: `${prefix}.folder`,
          message: 'Folder/prefix contains characters that are unsafe in an object key — use letters, numbers and - _ . / ! * \' ( )',
          code: 'invalid_folder',
        })
      } else if (rawFolder.trim().endsWith('/')) {
        warnings.push({
          field: `${prefix}.folder`,
          message: 'Trailing "/" on the folder/prefix will be trimmed before registration',
          code: 'folder_trailing_slash',
        })
      }
    }

    // Region (optional, informational — NOT sent to ACS).
    const region = typeof fields.region === 'string' ? fields.region.trim() : ''
    if (region) {
      const regionOk = provider === 'gcp' ? GCP_REGION_RE.test(region) : AWS_REGION_RE.test(region)
      if (!regionOk) {
        errors.push({
          field: `${prefix}.region`,
          message:
            provider === 'gcp'
              ? `"${region}" is not a valid GCP region (e.g. us-central1)`
              : `"${region}" is not a valid AWS region (e.g. us-east-1)`,
          code: 'invalid_region',
        })
      } else {
        warnings.push({
          field: `${prefix}.region`,
          message:
            'Region is not sent to ACS — it is derived from the bucket. Ensure the bucket lives in the SAME region as the Splunk Cloud stack, or DDSS rolls will fail',
          code: 'region_reminder',
        })
      }
    }

    // Target index (optional) — the index this location is intended for.
    const targetIndex = typeof fields.targetIndex === 'string' ? fields.targetIndex.trim() : ''
    if (targetIndex) {
      if (!INDEX_NAME_RE.test(targetIndex)) {
        errors.push({
          field: `${prefix}.targetIndex`,
          message:
            'Target index name must begin with a lowercase letter or number and contain only lowercase letters, numbers, underscores and hyphens',
          code: 'invalid_index_name',
        })
      } else {
        warnings.push({
          field: `${prefix}.targetIndex`,
          message: `To actually route index "${targetIndex}" here, set that index's DDSS Self Storage Bucket in the "indexes" config type — this location only registers the bucket on the stack`,
          code: 'index_attach_hint',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
