import { capabilityFor } from './capabilities'
import type { ValidationWarning } from '@veltrixsecops/app-sdk'

/** These warnings are part of pipeline validation and therefore deployment review. */
export function capabilityWarnings(id: string): ValidationWarning[] {
  return (capabilityFor(id)?.rollbackLimits ?? []).map(message => ({
    field: 'configuration', code: 'rollback_limit', message,
  }))
}
