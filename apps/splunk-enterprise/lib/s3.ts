// =============================================================================
// S3 access for Splunk version installer package uploads.
//
// The bucket is provisioned by Terraform (terraform/server: aws_s3_bucket
// "splunk_packages") and its name is passed to the app as SPLUNK_PACKAGES_BUCKET.
// The app server runs on an EC2 instance whose instance profile grants
// s3:PutObject/GetObject/DeleteObject on the bucket, so no static credentials
// are needed — the default AWS credential chain resolves the role.
//
// Uploads never proxy through the API: the server mints a short-lived presigned
// PUT URL and the browser transfers the (large) installer straight to S3. The
// version record stores the object as `s3://<bucket>/<key>` in download_url;
// downloads are served by presigning a GET URL on demand (the bucket is private).
// =============================================================================

import { S3 } from 'aws-sdk'

const S3_URI_PREFIX = 's3://'
const DEFAULT_EXPIRY_SECONDS = 900 // 15 minutes

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'

/** The configured uploads bucket, or null when the app is not S3-configured. */
export function packagesBucket(): string | null {
  const bucket = process.env.SPLUNK_PACKAGES_BUCKET
  return bucket && bucket.trim() ? bucket.trim() : null
}

/** True when package uploads are available (bucket configured). */
export function uploadsEnabled(): boolean {
  return packagesBucket() !== null
}

let cachedClient: S3 | null = null
function client(): S3 {
  if (!cachedClient) cachedClient = new S3({ region, signatureVersion: 'v4' })
  return cachedClient
}

/** Deterministic, path-safe object key for a tenant's version installer package. */
export function packageKey(customerId: string, versionId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'package'
  return `versions/${customerId}/${versionId}/${safe}`
}

/** `s3://bucket/key` reference stored in a version's download_url. */
export function toS3Uri(bucket: string, key: string): string {
  return `${S3_URI_PREFIX}${bucket}/${key}`
}

/** Parse an `s3://bucket/key` reference, or null if not an S3 URI. */
export function parseS3Uri(value: string | null | undefined): { bucket: string; key: string } | null {
  if (!value || !value.startsWith(S3_URI_PREFIX)) return null
  const rest = value.slice(S3_URI_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) }
}

/** Short-lived presigned PUT URL for uploading an installer package. */
export function presignUpload(
  key: string,
  contentType: string,
  expiresSeconds: number = DEFAULT_EXPIRY_SECONDS,
): Promise<string> {
  const bucket = packagesBucket()
  if (!bucket) throw new Error('Package uploads are not configured (SPLUNK_PACKAGES_BUCKET unset)')
  return client().getSignedUrlPromise('putObject', {
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    Expires: expiresSeconds,
  })
}

/** Short-lived presigned GET URL for downloading a stored installer package. */
export function presignDownload(
  bucket: string,
  key: string,
  expiresSeconds: number = DEFAULT_EXPIRY_SECONDS,
): Promise<string> {
  return client().getSignedUrlPromise('getObject', { Bucket: bucket, Key: key, Expires: expiresSeconds })
}

/** Best-effort delete of a stored package; never throws. */
export async function deletePackage(bucket: string, key: string): Promise<void> {
  try {
    await client().deleteObject({ Bucket: bucket, Key: key }).promise()
  } catch (err) {
    console.error('[splunk-enterprise] failed to delete package', key, err)
  }
}
