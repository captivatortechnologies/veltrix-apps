// =============================================================================
// rate-limit-settings — deploy, driven against the fake Okta org.
//
// These are the dials that decide when the org starts refusing traffic. They are
// three org SINGLETONS replaced wholesale by PUT — no list, no create, no
// lifecycle — so the risks are different from every other config type here:
// sending the wrong full-replace body silently drops overrides, and flipping
// per-client mode to DISABLE removes a brute-force defence org-wide. The tests
// assert the exact bodies sent, the read-before-write capture, and the failure
// contract.
// =============================================================================

import deploy from '../deploy'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const ADMIN_PATH = '/rate-limit-settings/admin-notifications'
const PER_CLIENT_PATH = '/rate-limit-settings/per-client'
const THRESHOLD_PATH = '/rate-limit-settings/warning-threshold'

function limits(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Org rate limits',
    fields: {
      adminNotificationsEnabled: true,
      perClientDefaultMode: 'ENFORCE',
      perClientLoginPageMode: 'INHERIT',
      perClientOAuth2AuthorizeMode: 'INHERIT',
      perClientOIEAppIntentMode: 'INHERIT',
      ...fields,
    },
  }
}

const LIVE_ADMIN = { notificationsEnabled: true }
const LIVE_PER_CLIENT = {
  defaultMode: 'ENFORCE',
  useCaseModeOverrides: { LOGIN_PAGE: 'PREVIEW' },
  _links: { self: { href: `${API_BASE}${PER_CLIENT_PATH}` } },
}

describe('rate-limit-settings deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [limits()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [limits()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [limits()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses an empty canvas without touching the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [] }))
      expect(result.success).toBe(false)
      expect(result.message).toBe('No rate-limit configuration provided')
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [limits()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('reads both singletons before writing either of them', async () => {
    await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [limits()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(ADMIN_PATH)
      expect(calls[1].method).toBe('GET')
      expect(calls[1].path).toBe(PER_CLIENT_PATH)
      expect(calls[2].method).toBe('PUT')
    })
  })

  it('never lists or creates — these are org singletons, not a collection', async () => {
    await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [limits()] }))

      expect(calls.some((c) => c.method === 'POST')).toBe(false)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
      for (const call of writeCalls(calls)) expect(call.method).toBe('PUT')
    })
  })

  it('sends the exact admin-notifications and per-client bodies', async () => {
    await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            limits({
              adminNotificationsEnabled: false,
              perClientDefaultMode: 'PREVIEW',
              perClientLoginPageMode: 'ENFORCE',
            }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].path).toBe(ADMIN_PATH)
      expect(writes[0].json).toEqual({ notificationsEnabled: false })
      expect(writes[1].path).toBe(PER_CLIENT_PATH)
      expect(writes[1].json).toEqual({
        defaultMode: 'PREVIEW',
        useCaseModeOverrides: { LOGIN_PAGE: 'ENFORCE' },
      })
    })
  })

  it('always sends useCaseModeOverrides so INHERIT actually clears a live override', async () => {
    await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [limits()] }))

      // The live org has LOGIN_PAGE=PREVIEW; every declared override is INHERIT,
      // so an empty object must be sent — omitting the key would leave the
      // override in place and the config would never converge.
      expect(writeCalls(calls)[1].json.useCaseModeOverrides).toEqual({})
    })
  })

  it('carries every declared per-use-case override into the body', async () => {
    await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({})], async (calls) => {
      await deploy(
        deployContext({
          sections: [
            limits({
              perClientLoginPageMode: 'enforce',
              perClientOAuth2AuthorizeMode: 'PREVIEW',
              perClientOIEAppIntentMode: 'DISABLE',
            }),
          ],
        }),
      )

      expect(writeCalls(calls)[1].json.useCaseModeOverrides).toEqual({
        LOGIN_PAGE: 'ENFORCE',
        OAUTH2_AUTHORIZE: 'PREVIEW',
        OIE_APP_INTENT: 'DISABLE',
      })
    })
  })

  it('captures the prior state of both singletons for rollback, with _links stripped', async () => {
    const result = await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({})], async () =>
      deploy(deployContext({ sections: [limits({ adminNotificationsEnabled: false })] })),
    )

    const rb = result.rollbackData as {
      priorAdminNotifications: { notificationsEnabled: boolean }
      priorPerClient: Record<string, unknown>
      priorWarningThreshold?: unknown
    }
    expect(rb.priorAdminNotifications).toEqual({ notificationsEnabled: true })
    expect(rb.priorPerClient).toEqual({
      defaultMode: 'ENFORCE',
      useCaseModeOverrides: { LOGIN_PAGE: 'PREVIEW' },
    })
    expect(rb.priorWarningThreshold).toBeUndefined()
  })

  it('leaves the warning threshold alone when the canvas declares none', async () => {
    await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [limits()] }))

      expect(result.success).toBe(true)
      expect((result.artifacts as { applied: string[] }).applied).toEqual([
        'admin-notifications',
        'per-client',
      ])
      expect(calls.some((c) => c.path === THRESHOLD_PATH)).toBe(false)
    })
  })

  it('reads and writes the warning threshold when the canvas declares one', async () => {
    const result = await withFetch(
      [ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({ warningThreshold: 60 }), ok({}), ok({}), ok({})],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [limits({ warningThresholdPercent: 80 })] }))

        expect(calls[2].method).toBe('GET')
        expect(calls[2].path).toBe(THRESHOLD_PATH)
        const threshold = writeCalls(calls).find((c) => c.path === THRESHOLD_PATH)
        expect(threshold?.json).toEqual({ warningThreshold: 80 })
        return res
      },
    )

    expect(result.success).toBe(true)
    expect((result.artifacts as { applied: string[] }).applied).toEqual([
      'admin-notifications',
      'per-client',
      'warning-threshold',
    ])
    expect((result.rollbackData as { priorWarningThreshold: unknown }).priorWarningThreshold).toEqual({
      warningThreshold: 60,
    })
  })

  it('captures no prior threshold when the org has none set', async () => {
    const result = await withFetch(
      [ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({}), ok({}), ok({})],
      async () => deploy(deployContext({ sections: [limits({ warningThresholdPercent: 80 })] })),
    )

    expect(result.success).toBe(true)
    expect(
      (result.rollbackData as { priorWarningThreshold?: unknown }).priorWarningThreshold,
    ).toBeUndefined()
  })

  it('accepts a numeric threshold supplied as a string from the canvas', async () => {
    await withFetch(
      [ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({ warningThreshold: 60 }), ok({}), ok({}), ok({})],
      async (calls) => {
        await deploy(deployContext({ sections: [limits({ warningThresholdPercent: '75' })] }))

        const threshold = writeCalls(calls).find((c) => c.path === THRESHOLD_PATH)
        expect(threshold?.json).toEqual({ warningThreshold: 75 })
      },
    )
  })

  it('refuses to write anything when the prior state cannot be read', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [limits()] }))
      // Without a captured prior there would be nothing to roll back to, so the
      // deploy must not proceed.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to read admin-notification settings/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('refuses to write when the per-client read fails after the admin read succeeded', async () => {
    const result = await withFetch(
      [ok(LIVE_ADMIN), apiError('Insufficient permissions', 403)],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [limits()] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to read per-client rate-limit settings/)
  })

  it('returns a FAILED result rather than throwing when the admin PUT is rejected', async () => {
    const result = await withFetch(
      [ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), apiError('Api validation failed', 400, ['not permitted'])],
      async () => deploy(deployContext({ sections: [limits()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/applying 0 part\(s\) \(none\)/)
    expect(result.message).toMatch(/Api validation failed/)
    expect(result.message).toMatch(/not permitted/)
  })

  it('names the parts it did apply when a later PUT is rejected', async () => {
    const result = await withFetch(
      [ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [limits()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/applying 1 part\(s\) \(admin-notifications\)/)
    expect((result.artifacts as { applied: string[] }).applied).toEqual(['admin-notifications'])
  })

  it('returns a FAILED result when only the threshold PUT is rejected', async () => {
    const result = await withFetch(
      [
        ok(LIVE_ADMIN),
        ok(LIVE_PER_CLIENT),
        ok({ warningThreshold: 60 }),
        ok({}),
        ok({}),
        apiError('Threshold out of range', 400),
      ],
      async () => deploy(deployContext({ sections: [limits({ warningThresholdPercent: 90 })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update warning-threshold/)
    expect((result.artifacts as { applied: string[] }).applied).toEqual([
      'admin-notifications',
      'per-client',
    ])
  })

  it('applies only the first configuration when a canvas declares more than one', async () => {
    await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [limits({ perClientDefaultMode: 'PREVIEW' }), limits({ perClientDefaultMode: 'DISABLE' })],
        }),
      )

      expect(result.success).toBe(true)
      // A singleton has one target; validate rejects a multi-section canvas, and
      // deploy must not apply both in sequence.
      expect(writeCalls(calls)).toHaveLength(2)
      expect(writeCalls(calls)[1].json.defaultMode).toBe('PREVIEW')
    })
  })

  it('does not depend on the platform data API', async () => {
    await withFetch([ok(LIVE_ADMIN), ok(LIVE_PER_CLIENT), ok({}), ok({})], async () => {
      const result = await deploy(deployContext({ sections: [limits()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })
})
