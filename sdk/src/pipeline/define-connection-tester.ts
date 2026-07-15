import type { TestConnectionContext, TestConnectionResult } from '../types/pipeline'

/**
 * Define a connection-test handler for an app. The platform runs it in-process
 * with the decrypted credential to verify a Connection's endpoint + credentials
 * before they're relied on for deployments.
 */
export function defineConnectionTester(
  handler: (ctx: TestConnectionContext) => Promise<TestConnectionResult>,
): (ctx: TestConnectionContext) => Promise<TestConnectionResult> {
  return handler
}
