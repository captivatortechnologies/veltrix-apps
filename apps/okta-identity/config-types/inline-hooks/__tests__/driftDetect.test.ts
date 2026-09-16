// =============================================================================
// inline-hooks — driftDetect, driven against the fake Okta org.
//
// Drift here is somebody re-pointing the endpoint Okta consults mid-sign-in, or
// switching the hook off so the customisation silently stops applying. The
// write-only secrets (HTTP authScheme.value, OAUTH clientSecret) can never be
// read back, so comparing them would report drift forever — they must be skipped.
// =============================================================================

import driftDetect from '../driftDetect'
import type { LiveInlineHook } from '../validate'
import {
  apiError,
  driftContext,
  EMPTY_LIST,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const HOOK_TYPE = 'com.okta.oauth2.tokens.transform'
const SECRET = 'inline-hook-SUPERSECRET-header'
const CLIENT_SECRET = 'oauth-client-SUPERSECRET'

function hook(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Token transform',
    fields: {
      name: 'Veltrix token transform',
      type: HOOK_TYPE,
      status: 'ACTIVE',
      channelType: 'HTTP',
      uri: 'https://hooks.example.com/token',
      authHeaderKey: 'Authorization',
      authHeaderValue: SECRET,
      ...fields,
    },
  }
}

const IN_SYNC: LiveInlineHook = {
  id: 'ihLIVE',
  name: 'Veltrix token transform',
  type: HOOK_TYPE,
  version: '1.0.0',
  status: 'ACTIVE',
  system: false,
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  channel: {
    type: 'HTTP',
    version: '1.0.0',
    config: {
      uri: 'https://hooks.example.com/token',
      method: 'POST',
      headers: [],
      authScheme: { type: 'HEADER', key: 'Authorization' },
    },
  },
}

const withConfig = (config: Record<string, unknown>): LiveInlineHook => ({
  ...IN_SYNC,
  channel: { ...IN_SYNC.channel, config: { ...IN_SYNC.channel?.config, ...config } },
})

describe('inline-hooks driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [hook()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [hook()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config, filtered by hook type, and reports a clean hook as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [hook()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/inlineHooks')
      expect(calls[0].query.type).toBe(HOOK_TYPE)
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([withConfig({ uri: 'https://elsewhere.example.com' })])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [hook()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted hook as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [hook()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Veltrix token transform')
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('treats a same-named hook of a different type as missing, not as the declared hook', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, type: 'com.okta.saml.tokens.transform' }])],
      async () => driftDetect(driftContext({ sections: [hook()] })),
    )

    expect(result.diffs[0].actual).toBe('missing')
  })

  it('flags a re-pointed endpoint — the sign-in interception shape', async () => {
    const result = await withFetch(
      [ok([withConfig({ uri: 'https://attacker.evil.test/token' })])],
      async () => driftDetect(driftContext({ sections: [hook()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix token transform.uri')
    expect(diff?.expected).toBe('https://hooks.example.com/token')
    expect(diff?.actual).toBe('https://attacker.evil.test/token')
    expect(diff?.severity).toBe('critical')
  })

  it('reports an endpoint that was cleared as "not set" rather than empty', async () => {
    const result = await withFetch([ok([withConfig({ uri: '' })])], async () =>
      driftDetect(driftContext({ sections: [hook()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix token transform.uri')
    expect(diff?.actual).toBe('not set')
  })

  it('flags a switched channel transport as critical drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, channel: { ...IN_SYNC.channel, type: 'OAUTH' } }])],
      async () => driftDetect(driftContext({ sections: [hook()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix token transform.channelType')
    expect(diff?.expected).toBe('HTTP')
    expect(diff?.actual).toBe('OAUTH')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a changed auth header key as a warning', async () => {
    const result = await withFetch(
      [ok([withConfig({ authScheme: { type: 'HEADER', key: 'X-Other' } })])],
      async () => driftDetect(driftContext({ sections: [hook()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix token transform.authHeaderKey')
    expect(diff?.expected).toBe('Authorization')
    expect(diff?.actual).toBe('X-Other')
    expect(diff?.severity).toBe('warning')
  })

  it('stays quiet when the live hook reports no auth header key at all', async () => {
    const result = await withFetch([ok([withConfig({ authScheme: { type: 'HEADER' } })])], async () =>
      driftDetect(driftContext({ sections: [hook()] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.authHeaderKey'))).toHaveLength(0)
  })

  it('never compares the write-only HTTP secret, so a live hook without it is in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [hook()] })),
    )

    expect(result.hasDrift).toBe(false)
    expect(JSON.stringify(result).includes(SECRET)).toBe(false)
  })

  it('diffs the OAUTH config blob but skips the write-only client secret', async () => {
    const declared = JSON.stringify({
      clientId: 'client-123',
      clientSecret: CLIENT_SECRET,
      tokenUrl: 'https://idp.example.com/token',
    })
    const liveOauth: LiveInlineHook = {
      ...IN_SYNC,
      channel: {
        type: 'OAUTH',
        version: '1.0.0',
        config: {
          uri: 'https://hooks.example.com/token',
          clientId: 'someone-elses-client',
          tokenUrl: 'https://idp.example.com/token',
        },
      },
    }

    const result = await withFetch([ok([liveOauth])], async () =>
      driftDetect(
        driftContext({ sections: [hook({ channelType: 'OAUTH', configJson: declared })] }),
      ),
    )

    const clientId = result.diffs.find((d) => d.field === 'Veltrix token transform.clientId')
    expect(clientId?.expected).toBe('client-123')
    expect(clientId?.actual).toBe('someone-elses-client')
    // clientSecret is never returned by Okta — diffing it would mean permanent
    // false-positive drift.
    expect(result.diffs.some((d) => d.field.endsWith('.clientSecret'))).toBe(false)
    expect(JSON.stringify(result).includes(CLIENT_SECRET)).toBe(false)
  })

  it('reports a missing OAUTH config key as "not set" rather than undefined', async () => {
    const liveOauth: LiveInlineHook = {
      ...IN_SYNC,
      channel: {
        type: 'OAUTH',
        version: '1.0.0',
        config: { uri: 'https://hooks.example.com/token' },
      },
    }

    const result = await withFetch([ok([liveOauth])], async () =>
      driftDetect(
        driftContext({
          sections: [
            hook({ channelType: 'OAUTH', configJson: JSON.stringify({ tokenUrl: 'https://idp.example.com/token' }) }),
          ],
        }),
      ),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix token transform.tokenUrl')
    expect(diff?.actual).toBe('not set')
  })

  it('does not diff the config blob for an HTTP channel', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(
        driftContext({
          sections: [hook({ configJson: JSON.stringify({ clientId: 'ignored-for-http' }) })],
        }),
      ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a hook switched off out of band as a warning, not a critical', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [hook()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix token transform.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('does not flag server-managed fields such as lastUpdated or system', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, lastUpdated: '2026-09-09T00:00:00.000Z', system: true }])],
      async () => driftDetect(driftContext({ sections: [hook()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('reports an unreadable hook list as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [hook()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].severity).toBe('critical')
    expect(result.diffs[0].actual).toMatch(/unreachable/)
    expect(result.diffs[0].actual).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining hooks after one becomes unreadable', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([{ ...IN_SYNC, name: 'Second hook' }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [hook(), { name: 'Second', fields: { ...hook({ name: 'Second hook' }).fields } }],
          }),
        ),
    )

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('Veltrix token transform')
  })

  it('makes no System Log call — this config type attaches no drift actor', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [hook()] }))

      expect(result.hasDrift).toBe(true)
      expect(calls.some((c) => c.path === '/logs')).toBe(false)
      expect((result.diffs[0] as { actor?: unknown }).actor).toBeUndefined()
    })
  })
})
