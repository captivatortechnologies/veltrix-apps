// =============================================================================
// event-hooks — driftDetect, driven against the fake Okta org.
//
// Drift on an event hook is somebody re-pointing the org's outbound event feed,
// widening what it listens to, or switching it off. The write-only auth secret
// can never be read back, so it must never be compared — a handler that "sees"
// drift there would report a permanent false positive on every check.
// =============================================================================

import driftDetect from '../driftDetect'
import type { LiveEventHook } from '../validate'
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

const SECRET = 'hook-auth-SUPERSECRET-value'

function hook(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Audit hook',
    fields: {
      name: 'Veltrix audit hook',
      status: 'ACTIVE',
      eventItems: ['user.lifecycle.create', 'user.lifecycle.deactivate'],
      uri: 'https://hooks.example.com/okta',
      authHeaderKey: 'Authorization',
      authHeaderValue: SECRET,
      ...fields,
    },
  }
}

const IN_SYNC: LiveEventHook = {
  id: 'ehLIVE',
  name: 'Veltrix audit hook',
  status: 'ACTIVE',
  verificationStatus: 'VERIFIED',
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  events: { type: 'EVENT_TYPE', items: ['user.lifecycle.create', 'user.lifecycle.deactivate'] },
  channel: {
    type: 'HTTP',
    version: '1.0.0',
    config: {
      uri: 'https://hooks.example.com/okta',
      authScheme: { type: 'HEADER', key: 'Authorization' },
    },
  },
}

const withConfig = (config: Record<string, unknown>): LiveEventHook => ({
  ...IN_SYNC,
  channel: { ...IN_SYNC.channel, config: { ...IN_SYNC.channel?.config, ...config } },
})

describe('event-hooks driftDetect', () => {
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

  it('reads the deployed config and reports a clean hook as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [hook()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/eventHooks')
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
    const diff = result.diffs.find((d) => d.field === 'Veltrix audit hook')
    expect(diff).toBeDefined()
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a re-pointed channel URI — the event-exfiltration shape', async () => {
    const result = await withFetch(
      [ok([withConfig({ uri: 'https://attacker.evil.test/collect' })])],
      async () => driftDetect(driftContext({ sections: [hook()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix audit hook.channel.uri')
    expect(diff?.expected).toBe('https://hooks.example.com/okta')
    expect(diff?.actual).toBe('https://attacker.evil.test/collect')
    expect(diff?.severity).toBe('critical')
  })

  it('reports a channel URI that was cleared as "not set" rather than empty', async () => {
    const result = await withFetch([ok([withConfig({ uri: '' })])], async () =>
      driftDetect(driftContext({ sections: [hook()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix audit hook.channel.uri')
    expect(diff?.actual).toBe('not set')
  })

  it('flags a changed subscription set as critical drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, events: { type: 'EVENT_TYPE', items: ['user.lifecycle.create'] } }])],
      async () => driftDetect(driftContext({ sections: [hook()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix audit hook.events')
    expect(diff?.expected).toEqual(['user.lifecycle.create', 'user.lifecycle.deactivate'].sort())
    expect(diff?.actual).toEqual(['user.lifecycle.create'])
    expect(diff?.severity).toBe('critical')
  })

  it('does not read a re-ordered subscription list as drift', async () => {
    const result = await withFetch(
      [
        ok([
          {
            ...IN_SYNC,
            events: { type: 'EVENT_TYPE', items: ['user.lifecycle.deactivate', 'user.lifecycle.create'] },
          },
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [hook()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a changed auth header key', async () => {
    const result = await withFetch(
      [ok([withConfig({ authScheme: { type: 'HEADER', key: 'X-Other' } })])],
      async () => driftDetect(driftContext({ sections: [hook()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix audit hook.channel.authHeaderKey')
    expect(diff?.expected).toBe('Authorization')
    expect(diff?.actual).toBe('X-Other')
  })

  it('never compares the write-only auth secret, so a live hook without it is in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [hook()] })),
    )

    // Okta never returns authScheme.value; comparing it would mean permanent
    // false-positive drift on every single check.
    expect(result.hasDrift).toBe(false)
    expect(JSON.stringify(result).includes(SECRET)).toBe(false)
  })

  it('flags changed extra headers order-insensitively', async () => {
    const declared = '[{"key":"X-Trace","value":"1"},{"key":"X-Env","value":"prod"}]'

    const reordered = await withFetch(
      [
        ok([
          withConfig({
            headers: [
              { key: 'X-Env', value: 'prod' },
              { key: 'X-Trace', value: '1' },
            ],
          }),
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [hook({ headersJson: declared })] })),
    )
    expect(reordered.hasDrift).toBe(false)

    const changed = await withFetch(
      [ok([withConfig({ headers: [{ key: 'X-Trace', value: '2' }] })])],
      async () => driftDetect(driftContext({ sections: [hook({ headersJson: declared })] })),
    )
    const diff = changed.diffs.find((d) => d.field === 'Veltrix audit hook.channel.headers')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a hook switched off out of band as a warning, not a critical', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [hook()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Veltrix audit hook.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('does not flag a server-managed field such as verificationStatus', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, verificationStatus: 'UNVERIFIED', lastUpdated: '2026-09-09T00:00:00.000Z' }])],
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
    expect(result.diffs[0].field).toBe('Veltrix audit hook')
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
