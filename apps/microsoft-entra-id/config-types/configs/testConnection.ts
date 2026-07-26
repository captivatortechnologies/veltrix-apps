// =============================================================================
// TEST CONNECTION HANDLER
//
// Backs the "Test" button on the Connections page: a standalone probe that
// verifies a Connection's endpoint + credential actually work, independent of
// any config or canvas. The platform decrypts the credential and runs this
// in-process, so ctx.credential carries real secrets (never returned).
//
// Wire it in the manifest under the config type's handlers:  testConnection: ...
// =============================================================================

import type { TestConnectionContext, TestConnectionResult } from '@veltrixsecops/app-sdk'

export default async function testConnection(
  ctx: TestConnectionContext,
): Promise<TestConnectionResult> {
  const { endpoint, credential } = ctx

  if (!endpoint) return { ok: false, message: 'No endpoint configured for this connection.' }
  if (!credential) return { ok: false, message: 'No credential attached to this connection.' }

  try {
    // Replace with the cheapest authenticated call your tool offers (a whoami /
    // server-info / health endpoint). Keep it fast and read-only.
    const res = await fetch(new URL('/services/server/info', endpoint), {
      headers: {
        ...(credential.apiToken
          ? { Authorization: `Bearer ${credential.apiToken}` }
          : credential.username
            ? {
                Authorization: `Basic ${Buffer.from(
                  `${credential.username}:${credential.password ?? ''}`,
                ).toString('base64')}`,
              }
            : {}),
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { ok: false, message: `Endpoint returned HTTP ${res.status}.` }
    return { ok: true, message: 'Connection verified.' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed.' }
  }
}
