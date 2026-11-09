import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { readAccountConnection, readSubscriptionConnection, targetKindOf } from '../lib/accountConnection'

interface TestConnectionContext {
  appId: string
  customerId: string
  endpoint: string | null
  credential: CredentialRef | null
  component: { hostname?: string | null; type?: string[] | null } | null
  connectivity: unknown
  settings: Record<string, unknown>
}
interface TestConnectionResult {
  ok: boolean
  message: string
  details?: string[]
  latencyMs?: number
}

/**
 * Shape check only. The app must never hold or exercise cloud credentials, so
 * the live check belongs to the platform: AssumeRole in the runner for AWS,
 * the Verify action on the connection (ARM probe) for Azure. The result says
 * so rather than claiming the account was reached.
 */
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const started = Date.now()
  const endpoint = ctx.endpoint ?? ctx.component?.hostname
  if (targetKindOf(ctx.component?.type, endpoint) === 'azure-subscription') {
    const { value, errors } = readSubscriptionConnection(endpoint, ctx.credential)
    if (!value) return { ok: false, message: errors[0], details: errors, latencyMs: Date.now() - started }
    return {
      ok: true,
      message: `Subscription connection for ${value.subscriptionId} is well-formed.`,
      details: [
        `Connector: ${value.connectorClientId}`,
        'Reader access is verified by the connection\'s Verify action (the platform probes the subscription with an app-only token).',
      ],
      latencyMs: Date.now() - started,
    }
  }
  const { value, errors } = readAccountConnection(endpoint, ctx.credential)
  if (!value) return { ok: false, message: errors[0], details: errors, latencyMs: Date.now() - started }
  return {
    ok: true,
    message: `Account connection for ${value.accountId} is well-formed.`,
    details: [
      `Role: ${value.roleArn}`,
      'External ID: present',
      'Live AssumeRole is verified by the platform runner on the first run, not by this check.',
    ],
    latencyMs: Date.now() - started,
  }
}
