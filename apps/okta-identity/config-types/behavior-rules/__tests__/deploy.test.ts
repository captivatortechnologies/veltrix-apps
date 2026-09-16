// =============================================================================
// behavior-rules — deploy, driven against the fake Okta org.
//
// Behavior rules are what a sign-on policy reads to decide "this login is
// anomalous, step it up". Deploy one wrong — or leave it INACTIVE — and the
// policy that references it silently stops challenging anyone. Okta has no
// upsert and status only moves through the lifecycle endpoints; these tests
// assert the request sequence, the exact bodies, the rollback state and the
// failure contract.
// =============================================================================

import deploy from '../deploy'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
  EMPTY_LIST,
  leaksToken,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function behavior(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Impossible travel',
    fields: {
      type: 'VELOCITY',
      name: 'Impossible travel',
      status: 'ACTIVE',
      settingsJson: '{"velocityKph":805}',
      ...fields,
    },
  }
}

const LIVE = {
  id: 'beh-1',
  name: 'Impossible travel',
  type: 'VELOCITY',
  status: 'ACTIVE',
  settings: { velocityKph: 500 },
  created: '2025-01-01T00:00:00.000Z',
  lastUpdated: '2025-06-01T00:00:00.000Z',
  _links: { self: { href: 'https://example.test' } },
}

describe('behavior-rules deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [behavior()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [behavior()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [behavior()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'beh-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [behavior()] }))

      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates a behavior the org does not have, with its parsed settings', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'beh-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [behavior()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/behaviors')

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/behaviors')
      expect(writes[0].json).toEqual({
        type: 'VELOCITY',
        name: 'Impossible travel',
        settings: { velocityKph: 805 },
      })
      // status is NEVER part of the body — it moves through the lifecycle.
      expect(writes[0].json.status).toBeUndefined()
    })
  })

  it('omits settings entirely when the canvas declares none, leaving Okta defaults intact', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'beh-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [behavior({ type: 'ANOMALOUS_IP', settingsJson: '' })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json).toEqual({ type: 'ANOMALOUS_IP', name: 'Impossible travel' })
    })
  })

  it('omits settings when the declared blob is an empty object', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'beh-NEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [behavior({ settingsJson: '{}' })] }))
      expect(writeCalls(calls)[0].json.settings).toBeUndefined()
    })
  })

  it('records the created behavior so rollback can delete it', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'beh-NEW', status: 'ACTIVE' })],
      async () => deploy(deployContext({ sections: [behavior()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.createdIds).toEqual(['beh-NEW'])
    expect(rb.previousState).toEqual([{ name: 'Impossible travel', existed: false, id: 'beh-NEW' }])
  })

  it('updates a behavior that already exists and captures its prior body and status', async () => {
    const result = await withFetch([ok([LIVE]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [behavior()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/behaviors/beh-1')
      expect(writes[0].json.settings).toEqual({ velocityKph: 805 })
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('beh-1')
    expect(entry.priorStatus).toBe('ACTIVE')
    // Server-managed fields are stripped so the captured body is safe to PUT back.
    expect(entry.prior).toEqual({
      name: 'Impossible travel',
      type: 'VELOCITY',
      settings: { velocityKph: 500 },
    })
  })

  it('matches a behavior by exact name and never adopts a differently named one', async () => {
    await withFetch(
      [ok([{ ...LIVE, id: 'beh-OTHER', name: 'impossible travel' }]), ok({ id: 'beh-NEW' }), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [behavior()] }))

        expect(result.success).toBe(true)
        expect(writeCalls(calls)[0].method).toBe('POST')
        expect(calls.some((c) => c.path === '/behaviors/beh-OTHER')).toBe(false)
      },
    )
  })

  it('follows pagination when the behavior list spans pages', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'beh-x', name: 'New device', type: 'ANOMALOUS_DEVICE' }],
          headers: { link: `<${API_BASE}/behaviors?after=abc>; rel="next"` },
        },
        ok([LIVE]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [behavior()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('abc')
        expect(writeCalls(calls)[0].path).toBe('/behaviors/beh-1')
      },
    )
  })

  it('never deletes anything while deploying', async () => {
    await withFetch([ok([LIVE]), ok({}), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [behavior({ status: 'INACTIVE' })] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('returns a FAILED result rather than throwing when the settings JSON is unusable', async () => {
    for (const settingsJson of ['not json', '[1,2,3]']) {
      const result = await withFetch([], async (calls) => {
        const res = await deploy(deployContext({ sections: [behavior({ settingsJson })] }))
        // It fails BEFORE any request — a malformed blob never reaches Okta.
        expect(calls).toHaveLength(0)
        return res
      })

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/settings \(settingsJson\) is not a valid JSON object/)
    }
  })

  it('deactivates a behavior that should no longer be evaluating logins', async () => {
    await withFetch([ok([LIVE]), ok({}), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [behavior({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[1].method).toBe('POST')
      expect(writes[1].path).toBe('/behaviors/beh-1/lifecycle/deactivate')
    })
  })

  it('re-activates a behavior an admin had turned off', async () => {
    await withFetch([ok([{ ...LIVE, status: 'INACTIVE' }]), ok({}), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [behavior()] }))
      expect(writeCalls(calls)[1].path).toBe('/behaviors/beh-1/lifecycle/activate')
    })
  })

  it('leaves the lifecycle alone when the behavior is already in the desired status', async () => {
    await withFetch([ok([LIVE]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [behavior()] }))
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('deactivates a freshly created behavior that should not be live yet', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'beh-NEW', status: 'ACTIVE' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [behavior({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path === '/behaviors/beh-NEW/lifecycle/deactivate')).toBe(true)
    })
  })

  it('treats a 404 on the lifecycle transition as already-in-that-state', async () => {
    await withFetch([ok([LIVE]), ok({}), notFound()], async () => {
      const result = await deploy(deployContext({ sections: [behavior({ status: 'INACTIVE' })] }))
      expect(result.success).toBe(true)
    })
  })

  it('fails the deploy when the lifecycle transition is rejected outright', async () => {
    const result = await withFetch(
      [ok([LIVE]), ok({}), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [behavior({ status: 'INACTIVE' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to deactivate behavior beh-1/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [behavior()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list behaviors while resolving "Impossible travel"/)
    expect(result.message).toMatch(/Insufficient permissions/)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE]), apiError('Api validation failed: settings', 400, ['velocityKph: too low'])],
      async () => deploy(deployContext({ sections: [behavior()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update behavior "Impossible travel"/)
    expect(result.message).toMatch(/velocityKph: too low/)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Behavior detection is not enabled for this org', 403)],
      async () => deploy(deployContext({ sections: [behavior()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create behavior "Impossible travel"/)
  })

  it('fails loudly when a create succeeds but the API returns no id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [behavior()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('reports partial progress and keeps rollback state when a later behavior fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'beh-ONE', status: 'ACTIVE' }), EMPTY_LIST, apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [behavior(), behavior({ name: 'New device', type: 'ANOMALOUS_DEVICE' })],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['beh-ONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('does not depend on the platform handing back a prior deployment', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'beh-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [behavior()], platformThrows: true }))
      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/behaviors')
    })
  })

  it('ignores a section with no name or type', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [{ name: 'Blank', fields: { type: '', name: '' } }] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('normalises a lower-case type so it still deploys as the Okta enum', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'beh-NEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [behavior({ type: 'velocity' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json.type).toBe('VELOCITY')
    })
  })
})
