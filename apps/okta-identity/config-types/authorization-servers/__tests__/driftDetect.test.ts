// =============================================================================
// authorization-servers — driftDetect, driven against the fake Okta org.
//
// Drift here is somebody widening or repointing the thing that issues access
// tokens: a changed audience means tokens are suddenly valid for a different
// API, a deactivated server means they stop being issued at all. The tests
// assert each drift shape the handler actually compares, that an unreadable org
// is reported rather than thrown, and that detection writes NOTHING.
// =============================================================================

import driftDetect from '../driftDetect'
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

function server(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Partner API',
    fields: {
      name: 'Partner API',
      description: 'Tokens for the partner integration',
      audiences: ['api://partner'],
      status: 'ACTIVE',
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: 'aus1a2b3c',
  name: 'Partner API',
  description: 'Tokens for the partner integration',
  audiences: ['api://partner'],
  issuerMode: 'ORG_URL',
  status: 'ACTIVE',
  issuer: 'https://dev-12345.okta.com/oauth2/aus1a2b3c',
  credentials: { signing: { rotationMode: 'AUTO' } },
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: {} },
}

describe('authorization-servers driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [server()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [server()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean server as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [server()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/authorizationServers')
      expect(calls[0].method).toBe('GET')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async (calls) => {
      await driftDetect(driftContext({ sections: [server()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('does not read Okta-managed readOnly fields as drift', async () => {
    const result = await withFetch(
      [
        ok([
          {
            ...IN_SYNC,
            lastUpdated: '2026-09-01T00:00:00.000Z',
            credentials: { signing: { rotationMode: 'MANUAL', kid: 'rotated' } },
            _links: { self: { href: 'changed' } },
          },
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [server()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a deleted authorization server as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [server()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('Partner API')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags a repointed audience — the token-scope takeover shape', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, audiences: ['api://attacker'] }])],
      async () => driftDetect(driftContext({ sections: [server()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Partner API.audiences')
    expect(diff).toBeDefined()
    expect(diff?.expected).toBe('api://partner')
    expect(diff?.actual).toBe('api://attacker')
    expect(diff?.severity).toBe('critical')
  })

  it('reports an audience that was removed entirely as "not set"', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, audiences: [] }])], async () =>
      driftDetect(driftContext({ sections: [server()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Partner API.audiences')
    expect(diff?.actual).toBe('not set')
  })

  it('flags a rewritten description', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, description: 'Edited in the admin console' }])],
      async () => driftDetect(driftContext({ sections: [server()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Partner API.description')
    expect(diff?.expected).toBe('Tokens for the partner integration')
    expect(diff?.actual).toBe('Edited in the admin console')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a cleared description as "not set" rather than silently matching', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, description: '   ' }])], async () =>
      driftDetect(driftContext({ sections: [server()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Partner API.description')
    expect(diff?.actual).toBe('not set')
  })

  it('compares issuerMode only when the canvas authored it', async () => {
    const authored = await withFetch(
      [ok([{ ...IN_SYNC, issuerMode: 'DYNAMIC' }])],
      async () => driftDetect(driftContext({ sections: [server({ issuerMode: 'ORG_URL' })] })),
    )
    const diff = authored.diffs.find((d) => d.field === 'Partner API.issuerMode')
    expect(diff?.expected).toBe('ORG_URL')
    expect(diff?.actual).toBe('DYNAMIC')

    const unauthored = await withFetch(
      [ok([{ ...IN_SYNC, issuerMode: 'DYNAMIC' }])],
      async () => driftDetect(driftContext({ sections: [server()] })),
    )
    expect(unauthored.diffs.filter((d) => d.field.endsWith('.issuerMode'))).toHaveLength(0)
  })

  it('flags a server deactivated out of band as a warning, not critical', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [server()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Partner API.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('reports an unreadable org as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [server()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].severity).toBe('critical')
    expect(result.diffs[0].expected).toBe('reachable')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining servers after one is unreadable', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([IN_SYNC])],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              server(),
              {
                name: 'Second',
                fields: { name: 'Second API', audiences: ['api://second'], status: 'ACTIVE' },
              },
            ],
          }),
        ),
    )

    // The second server is absent from the page returned for it — reported
    // separately from the first server's unreadable error.
    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[1].field).toBe('Second API')
    expect(result.diffs[1].actual).toBe('missing')
  })

  it('ignores a section the validator would have rejected', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({
          sections: [{ name: 'Bad', fields: { name: 'Bad', audiences: ['a', 'b'] } }],
        }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
