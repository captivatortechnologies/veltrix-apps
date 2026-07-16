import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateIndicators, extractIndicatorSpecs, NETWORK_INDICATOR_TYPES, checkNetworkValue } from '../../lib/indicators'

// Re-exported for the test + drift/health handlers.
export { extractIndicatorSpecs }

/**
 * Validate network indicators (IpAddress / DomainName / Url). Delegates to the
 * shared indicator validator with the network type set and value checker
 * (rejects CIDR ranges, bare-domain vs URL confusion, non-http(s) URLs).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateIndicators(ctx, NETWORK_INDICATOR_TYPES, checkNetworkValue)
}
