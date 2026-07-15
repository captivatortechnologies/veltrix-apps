// =============================================================================
// Pure S3 key / URI / bucket helpers for Splunk version package storage.
//
// Deliberately free of the aws-sdk import (which lives in ./s3 and is provided
// by the platform runtime, not this app's node_modules) so these helpers can be
// unit-tested and imported anywhere without pulling in the SDK.
// =============================================================================

export const S3_URI_PREFIX = 's3://';

/** The configured uploads bucket, or null when the app is not S3-configured. */
export function packagesBucket(): string | null {
  const bucket = process.env.SPLUNK_PACKAGES_BUCKET;
  return bucket && bucket.trim() ? bucket.trim() : null;
}

/** True when package uploads are available (bucket configured). */
export function uploadsEnabled(): boolean {
  return packagesBucket() !== null;
}

/** Deterministic, path-safe object key for a tenant's version installer package. */
export function packageKey(customerId: string, versionId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'package';
  return `versions/${customerId}/${versionId}/${safe}`;
}

/** `s3://bucket/key` reference stored in a version's download_url. */
export function toS3Uri(bucket: string, key: string): string {
  return `${S3_URI_PREFIX}${bucket}/${key}`;
}

/** Parse an `s3://bucket/key` reference, or null if not an S3 URI. */
export function parseS3Uri(value: string | null | undefined): { bucket: string; key: string } | null {
  if (!value || !value.startsWith(S3_URI_PREFIX)) return null;
  const rest = value.slice(S3_URI_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}
