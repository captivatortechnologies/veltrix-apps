// =============================================================================
// features — deploy, driven against the fake Okta org.
//
// Self-service features are org-wide switches that cannot be created or deleted,
// only toggled — so the whole handler is "find the named feature, then move its
// lifecycle". The failures that matter are toggling the wrong thing (a fuzzy name
// match), silently doing nothing when the feature does not exist, and forcing a
// dependency cascade the operator never asked for.
// =============================================================================

import deploy from '../deploy'
import type { LiveFeature } from '../validate'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  EMPTY_LIST,
  emptyCredential,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function feature(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Number challenge',
    fields: {
      name: 'Okta Verify Number Challenge',
      status: 'ENABLED',
      forceDependencies: false,
      ...fields,
    },
  }
}

const LIVE_FEATURE: LiveFeature = {
  id: 'ftLIVE',
  name: 'Okta Verify Number Challenge',
  description: 'Number challenge for Okta Verify push',
  type: 'self-service',
  status: 'DISABLED',
  stage: { state: 'OPEN', value: 'EA' },
  _links: { self: { href: `${API_BASE}/features/ftLIVE` } },
}

describe('features deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [feature()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [feature()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [feature()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([ok([LIVE_FEATURE]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [feature()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('toggles the feature through its lifecycle endpoint, keyed on the id', async () => {
    await withFetch([ok([LIVE_FEATURE]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [feature()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/features')

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/features/ftLIVE/ENABLE')
      expect(writes[0].body).toBe('')
    })
  })

  it('never creates or deletes — a feature can only ever be toggled', async () => {
    await withFetch([ok([LIVE_FEATURE]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [feature()] }))

      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(calls.some((c) => c.method === 'PUT')).toBe(false)
      expect(calls.some((c) => c.method === 'POST' && c.path === '/features')).toBe(false)
      expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
    })
  })

  it('disables a feature the canvas turns off', async () => {
    await withFetch([ok([{ ...LIVE_FEATURE, status: 'ENABLED' }]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [feature({ status: 'DISABLED' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].path).toBe('/features/ftLIVE/DISABLE')
    })
  })

  it('does not send mode=force unless the canvas asked for it', async () => {
    await withFetch([ok([LIVE_FEATURE]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [feature()] }))

      // Forcing silently cascades into dependent features — it must be opt-in.
      expect(writeCalls(calls)[0].query.mode).toBeUndefined()
    })
  })

  it('sends mode=force when the canvas opts into the dependency cascade', async () => {
    await withFetch([ok([LIVE_FEATURE]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [feature({ forceDependencies: true })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].query.mode).toBe('force')
    })
  })

  it('accepts the force flag as a canvas checkbox string', async () => {
    await withFetch([ok([LIVE_FEATURE]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [feature({ forceDependencies: 'true' })] }))
      expect(writeCalls(calls)[0].query.mode).toBe('force')
    })
  })

  it('makes no lifecycle call when the feature is already in the desired state', async () => {
    await withFetch([ok([{ ...LIVE_FEATURE, status: 'ENABLED' }])], async (calls) => {
      const result = await deploy(deployContext({ sections: [feature({ status: 'ENABLED' })] }))

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Reconciled 1 feature toggle/)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('records the prior status so rollback can put the switch back', async () => {
    const result = await withFetch([ok([LIVE_FEATURE]), ok({})], async () =>
      deploy(deployContext({ sections: [feature()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0]).toEqual({
      name: 'Okta Verify Number Challenge',
      id: 'ftLIVE',
      priorStatus: 'DISABLED',
    })
    expect(rb.createdIds).toEqual([])
  })

  it('records the prior status even when nothing needed changing', async () => {
    const result = await withFetch([ok([{ ...LIVE_FEATURE, status: 'ENABLED' }])], async () =>
      deploy(deployContext({ sections: [feature({ status: 'ENABLED' })] })),
    )

    const rb = result.rollbackData as { previousState: Array<Record<string, unknown>> }
    expect(rb.previousState[0].priorStatus).toBe('ENABLED')
  })

  it('matches the feature name case-insensitively', async () => {
    await withFetch([ok([LIVE_FEATURE]), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [feature({ name: '  okta verify NUMBER challenge ' })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].path).toBe('/features/ftLIVE/ENABLE')
    })
  })

  it('never toggles a feature whose name only partially matches', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE_FEATURE, name: 'Okta Verify Number Challenge (Legacy)' }])],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [feature()] }))
        // A fuzzy match would flip an org-wide switch nobody asked about.
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/was not found in this Okta org/)
  })

  it('fails with actionable guidance when the named feature does not exist', async () => {
    const result = await withFetch([EMPTY_LIST], async (calls) => {
      const res = await deploy(deployContext({ sections: [feature()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/cannot be created through the API/)
    expect((result.rollbackData as { previousState: unknown[] }).previousState).toEqual([])
  })

  it('fails when the matched feature carries no id', async () => {
    const result = await withFetch(
      [ok([{ name: 'Okta Verify Number Challenge', status: 'DISABLED' }])],
      async () => deploy(deployContext({ sections: [feature()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/was not found in this Okta org/)
  })

  it('returns a FAILED result rather than throwing when the toggle is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_FEATURE]), apiError('Feature has unmet dependencies', 400, ['requires: Okta Verify'])],
      async () => deploy(deployContext({ sections: [feature()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to enable feature ftLIVE/)
    expect(result.message).toMatch(/unmet dependencies/)
    expect(result.message).toMatch(/requires: Okta Verify/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result and writes nothing when the feature list cannot be read', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [feature()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list features/)
    expect(result.message).toMatch(/Insufficient permissions/)
  })

  it('does not treat a 404 on the toggle as success', async () => {
    const result = await withFetch(
      [ok([LIVE_FEATURE]), { status: 404, body: { errorSummary: 'Not found' } }],
      async () => deploy(deployContext({ sections: [feature()] })),
    )

    // Unlike a delete, a 404 on an enable means the switch was never moved.
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to enable feature/)
  })

  it('reports partial progress and keeps rollback state when a later feature fails', async () => {
    const result = await withFetch(
      [
        ok([LIVE_FEATURE]),
        ok({}),
        ok([{ ...LIVE_FEATURE, id: 'ftTWO', name: 'Second feature' }]),
        apiError('Insufficient permissions', 403),
      ],
      async () =>
        deploy(
          deployContext({
            sections: [feature(), { name: 'Second', fields: { ...feature({ name: 'Second feature' }).fields } }],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: Array<Record<string, unknown>> }
    // BOTH prior states were captured — the first was already toggled and the
    // second may have been half-applied.
    expect(rb.previousState).toHaveLength(2)
    expect(rb.previousState[0].id).toBe('ftLIVE')
    expect(rb.previousState[1].id).toBe('ftTWO')
  })

  it('follows pagination so a feature on a later page is still found', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'ftOTHER', name: 'Something else', status: 'ENABLED' }],
          headers: { link: `<${API_BASE}/features?after=ftOTHER>; rel="next"` },
        },
        ok([LIVE_FEATURE]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [feature()] }))

        expect(result.success).toBe(true)
        expect(calls.filter((c) => c.method === 'GET' && c.path === '/features')).toHaveLength(2)
        expect(writeCalls(calls)[0].path).toBe('/features/ftLIVE/ENABLE')
      },
    )
  })

  it('ignores a section with no feature name', async () => {
    await withFetch([ok([LIVE_FEATURE]), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [feature(), { name: 'Blank', fields: { name: '  ', status: 'ENABLED' } }] }),
      )

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Reconciled 1 feature toggle/)
      expect(writeCalls(calls)).toHaveLength(1)
    })
  })

  it('does not depend on the platform data API to resolve features', async () => {
    await withFetch([ok([LIVE_FEATURE]), ok({})], async () => {
      const result = await deploy(deployContext({ sections: [feature()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })
})
