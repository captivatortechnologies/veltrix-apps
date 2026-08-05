import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { runPolicyHealthCheck } from '../lib/catoPolicy'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return runPolicyHealthCheck(ctx, 'internetFirewall', 'Internet Firewall')
}
