import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateIndicators, extractIndicatorSpecs, CERT_INDICATOR_TYPES, checkCertThumbprint } from '../../lib/indicators'

// Re-exported for the test + drift/health handlers.
export { extractIndicatorSpecs }

/**
 * Validate certificate indicators (CertificateThumbprint). Delegates to the
 * shared indicator validator with the certificate type set and thumbprint
 * checker (SHA-1, 40 hex characters).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateIndicators(ctx, CERT_INDICATOR_TYPES, checkCertThumbprint)
}
