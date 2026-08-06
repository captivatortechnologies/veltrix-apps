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
//
// Uses the AWS SDK v3 (@aws-sdk/client-s3 + @aws-sdk/s3-request-presigner); the
// v2 `aws-sdk` mega-package is end-of-support. Those two packages are HOST-provided
// (peerDependencies) — the platform ships them for its own S3/SES/Cognito use and
// the deploy links them into the apps checkout — this app never bundles them.
//
// They are imported LAZILY (dynamic import inside each operation, `import type`
// for the types) rather than at module load: importing at the top level would
// couple this app's ENTIRE server module — and therefore every /byol, /versions
// and /upgrades route — to that dependency resolving. If the SDK is ever
// unavailable, the app still loads and only the upload/download/delete operations
// fail, with a clear message, instead of the whole app 404ing. (See issue #9.)
// =============================================================================

import type { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { packagesBucket } from './s3Keys'

// Re-export the pure key/URI/bucket helpers so existing importers of '../lib/s3'
// keep working; they live in ./s3Keys (aws-sdk-free) so they stay unit-testable.
export { packagesBucket, uploadsEnabled, packageKey, toS3Uri, parseS3Uri } from './s3Keys'

const DEFAULT_EXPIRY_SECONDS = 900 // 15 minutes

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'

/** The lazily-loaded SDK surface this module needs, with a shared client. */
interface S3Sdk {
  client: S3Client
  PutObjectCommand: typeof PutObjectCommand
  GetObjectCommand: typeof GetObjectCommand
  DeleteObjectCommand: typeof DeleteObjectCommand
  getSignedUrl: typeof getSignedUrl
}

let sdkPromise: Promise<S3Sdk> | null = null

/**
 * Resolve the AWS SDK v3 modules (and a cached S3 client) on first use. Kept out
 * of the module's import graph so `require('server/index')` never fails just
 * because @aws-sdk isn't resolvable — the requirement is deferred to the moment an
 * S3 operation actually runs. A failed load is not cached, so a later call retries.
 */
function loadSdk(): Promise<S3Sdk> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const s3 = await import('@aws-sdk/client-s3')
      const presigner = await import('@aws-sdk/s3-request-presigner')
      return {
        client: new s3.S3Client({ region }),
        PutObjectCommand: s3.PutObjectCommand,
        GetObjectCommand: s3.GetObjectCommand,
        DeleteObjectCommand: s3.DeleteObjectCommand,
        getSignedUrl: presigner.getSignedUrl,
      }
    })().catch((err) => {
      sdkPromise = null
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`AWS SDK (@aws-sdk/client-s3) is unavailable at runtime: ${detail}`)
    })
  }
  return sdkPromise
}

/** Short-lived presigned PUT URL for uploading an installer package. */
export async function presignUpload(
  key: string,
  contentType: string,
  expiresSeconds: number = DEFAULT_EXPIRY_SECONDS,
): Promise<string> {
  const bucket = packagesBucket()
  if (!bucket) throw new Error('Package uploads are not configured (SPLUNK_PACKAGES_BUCKET unset)')
  const sdk = await loadSdk()
  const command = new sdk.PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType })
  return sdk.getSignedUrl(sdk.client, command, { expiresIn: expiresSeconds })
}

/** Short-lived presigned GET URL for downloading a stored installer package. */
export async function presignDownload(
  bucket: string,
  key: string,
  expiresSeconds: number = DEFAULT_EXPIRY_SECONDS,
): Promise<string> {
  const sdk = await loadSdk()
  const command = new sdk.GetObjectCommand({ Bucket: bucket, Key: key })
  return sdk.getSignedUrl(sdk.client, command, { expiresIn: expiresSeconds })
}

/** Best-effort delete of a stored package; never throws. */
export async function deletePackage(bucket: string, key: string): Promise<void> {
  try {
    const sdk = await loadSdk()
    await sdk.client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }))
  } catch (err) {
    console.error('[splunk-enterprise] failed to delete package', key, err)
  }
}
