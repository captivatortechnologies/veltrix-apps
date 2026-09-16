// =============================================================================
// auth-server-scopes — driftDetect, driven against the fake Okta org.
//
// Drift on a scope is a quiet change to what a token is allowed to do: consent
// flipped from REQUIRED to IMPLICIT stops asking the user, `default: true` hands
// the scope out when nothing requested it, and metadataPublish advertises it to
// every client. The tests assert each shape the handler compares, the deliberate
// non-drift (a live system scope is never diffed), and that detection writes
// NOTHING.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  apiError,
  driftContext,
  EMPTY_LIST,
  leaksToken,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function scope(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'partner.read',
    fields: {
      authServerId: 'default',
      name: 'partner.read',
      displayName: 'Read partner data',
      description: 'Grants read access to the partner API',
      consent: 'REQUIRED',
      default: false,
      metadataPublish: 'NO_CLIENTS',
      optional: false,
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: 'scpLIVE',
  name: 'partner.read',
  displayName: 'Read partner data',
  description: 'Grants read access to the partner API',
  consent: 'REQUIRED',
  default: false,
  metadataPublish: 'NO_CLIENTS',
  optional: false,
  system: false,
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: {} },
}

describe('auth-server-scopes driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [scope()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [scope()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean scope as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [scope()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/authorizationServers/default/scopes')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, consent: 'IMPLICIT' }])], async (calls) => {
      await driftDetect(driftContext({ sections: [scope()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('does not read Okta-managed readOnly fields as drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, lastUpdated: '2026-09-01T00:00:00.000Z', _links: { self: { href: 'x' } } }])],
      async () => driftDetect(driftContext({ sections: [scope()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a deleted scope as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [scope()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('default:partner.read')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags consent downgraded to IMPLICIT — the user stops being asked', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, consent: 'IMPLICIT' }])], async () =>
      driftDetect(driftContext({ sections: [scope()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:partner.read.consent')
    expect(diff?.expected).toBe('REQUIRED')
    expect(diff?.actual).toBe('IMPLICIT')
    expect(diff?.severity).toBe('critical')
  })

  it('reports consent stripped out entirely as "not set"', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, consent: undefined }])], async () =>
      driftDetect(driftContext({ sections: [scope()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:partner.read.consent')
    expect(diff?.actual).toBe('not set')
  })

  it('flags a scope published to every client', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, metadataPublish: 'ALL_CLIENTS' }])],
      async () => driftDetect(driftContext({ sections: [scope()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:partner.read.metadataPublish')
    expect(diff?.expected).toBe('NO_CLIENTS')
    expect(diff?.actual).toBe('ALL_CLIENTS')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a scope quietly made default — granted when nothing requested it', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, default: true }])], async () =>
      driftDetect(driftContext({ sections: [scope()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:partner.read.default')
    expect(diff?.expected).toBe(false)
    expect(diff?.actual).toBe(true)
    expect(diff?.severity).toBe('warning')
  })

  it('flags a flipped optional flag', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, optional: true }])], async () =>
      driftDetect(driftContext({ sections: [scope()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'default:partner.read.optional')
    expect(diff?.expected).toBe(false)
    expect(diff?.actual).toBe(true)
  })

  it('treats a missing boolean as false rather than as drift against false', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, default: undefined, optional: undefined }])],
      async () => driftDetect(driftContext({ sections: [scope()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags rewritten consent-screen text', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, displayName: 'Full access', description: '   ' }])],
      async () => driftDetect(driftContext({ sections: [scope()] })),
    )

    const display = result.diffs.find((d) => d.field === 'default:partner.read.displayName')
    expect(display?.expected).toBe('Read partner data')
    expect(display?.actual).toBe('Full access')
    expect(display?.severity).toBe('warning')

    const description = result.diffs.find((d) => d.field === 'default:partner.read.description')
    expect(description?.actual).toBe('not set')
  })

  it('never diffs a live built-in system scope', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, system: true, consent: 'IMPLICIT', metadataPublish: 'ALL_CLIENTS' }])],
      async () => driftDetect(driftContext({ sections: [scope()] })),
    )

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toEqual([])
  })

  it('reports an unresolvable parent authorization server as critical drift, not a throw', async () => {
    const result = await withFetch([notFound()], async () =>
      driftDetect(driftContext({ sections: [scope({ authServerId: 'ausGONE' })] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('ausGONE:partner.read')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(String(result.diffs[0].actual)).toMatch(/Failed to list scopes/)
  })

  it('reports an unreadable org as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [scope()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].expected).toBe('reachable')
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining scopes after one is unreadable', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([IN_SYNC])],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              scope(),
              { name: 'Second', fields: { authServerId: 'default', name: 'partner.write' } },
            ],
          }),
        ),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[1].field).toBe('default:partner.write')
    expect(result.diffs[1].actual).toBe('missing')
  })

  it('ignores a section the validator would have rejected', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [{ name: 'Bad', fields: { name: 'orphan.scope' } }] }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
