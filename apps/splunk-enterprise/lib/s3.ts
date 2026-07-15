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
import { packagesBucket } from './s3Keys'

// Re-export the pure key/URI/bucket helpers so existing importers of '../lib/s3'
// keep working; they live in ./s3Keys (aws-sdk-free) so they stay unit-testable.
export { packagesBucket, uploadsEnabled, packageKey, toS3Uri, parseS3Uri } from './s3Keys'

const DEFAULT_EXPIRY_SECONDS = 900 // 15 minutes

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'

let cachedClient: S3 | null = null
function client(): S3 {
  if (!cachedClient) cachedClient = new S3({ region, signatureVersion: 'v4' })
  return cachedClient
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
