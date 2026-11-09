import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { readAccountConnection } from '../lib/accountConnection'

interface TestConnectionContext {
  appId: string
  customerId: string
  endpoint: string | null
  credential: CredentialRef | null
  component: { hostname?: string | null } | null
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
 * the live AssumeRole probe belongs to the platform runner; the result says so
 * rather than claiming the account was reached.
 */
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const started = Date.now()
  const { value, errors } = readAccountConnection(ctx.endpoint ?? ctx.component?.hostname, ctx.credential)
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
