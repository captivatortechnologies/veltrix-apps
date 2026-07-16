import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateIndicators, extractIndicatorSpecs, FILE_INDICATOR_TYPES, checkFileHash } from '../../lib/indicators'

// Re-exported for the test + drift/health handlers.
export { extractIndicatorSpecs }

/**
 * Validate file indicators (FileSha256 / FileSha1 / FileMd5). Delegates to the
 * shared indicator validator with the file type set and hash checker (validates
 * hex + length per hash algorithm). Prefer SHA-256 — SHA-1/MD5 are legacy.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateIndicators(ctx, FILE_INDICATOR_TYPES, checkFileHash)
}
