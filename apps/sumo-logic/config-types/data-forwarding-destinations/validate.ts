import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

/**
 * Validate data-forwarding-destination items: a non-empty name, a valid S3
 * bucket name, and the credentials matching the chosen authentication mode.
 * Static — no target access required. The destination name is the identity, so
 * a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one data forwarding destination.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const destinationName = String(item.fields.destinationName ?? '').trim()
    const bucketName = String(item.fields.bucketName ?? '').trim()
    const mode = String(item.fields.authenticationMode ?? '').trim()

    if (!destinationName) {
      errors.push({ field: `items[${i}].destinationName`, message: 'Destination name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = destinationName.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].destinationName`,
          message: `Destination name "${destinationName}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!bucketName) {
      errors.push({ field: `items[${i}].bucketName`, message: 'S3 bucket name is required.', code: 'EMPTY_BUCKET_NAME' })
    } else if (!BUCKET_NAME_RE.test(bucketName)) {
      errors.push({ field: `items[${i}].bucketName`, message: 'Must be a valid AWS S3 bucket name.', code: 'INVALID_BUCKET_NAME' })
    }

    if (mode !== 'AccessKey' && mode !== 'RoleBased') {
      errors.push({ field: `items[${i}].authenticationMode`, message: 'Authentication mode must be AccessKey or RoleBased.', code: 'INVALID_AUTH_MODE' })
    } else if (mode === 'RoleBased' && !String(item.fields.roleArn ?? '').trim()) {
      errors.push({ field: `items[${i}].roleArn`, message: 'IAM Role ARN is required when using IAM Role authentication.', code: 'EMPTY_ROLE_ARN' })
    } else if (mode === 'AccessKey') {
      if (!String(item.fields.accessKeyId ?? '').trim()) {
        errors.push({ field: `items[${i}].accessKeyId`, message: 'AWS Access Key ID is required when using AWS Access Key authentication.', code: 'EMPTY_ACCESS_KEY_ID' })
      }
      if (!String(item.fields.secretAccessKey ?? '').trim()) {
        errors.push({ field: `items[${i}].secretAccessKey`, message: 'AWS Secret Access Key is required when using AWS Access Key authentication.', code: 'EMPTY_SECRET_ACCESS_KEY' })
      }
      warnings.push({
        field: `items[${i}].authenticationMode`,
        message: `Destination "${destinationName || i}" uses long-lived AWS access keys — IAM Role authentication is recommended where available.`,
        code: 'ACCESS_KEY_MODE',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
