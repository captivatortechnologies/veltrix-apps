import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'

export default async function healthCheck(_ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return { healthy: false, score: 0, checks: [{ name: 'unsupported-authentication', passed: false, message: 'Terms of Use agreement management requires delegated authentication; manage agreements in Entra and reference existing IDs in Conditional Access.' }] }
}
