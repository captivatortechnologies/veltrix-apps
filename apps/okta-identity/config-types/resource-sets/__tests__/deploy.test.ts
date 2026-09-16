// =============================================================================
// resource-sets — deploy, driven against the fake Okta org.
//
// A resource set is the SCOPE half of a custom admin grant: whatever it contains
// is what a bound admin can act on. Adding one resource too many silently widens
// every binding that points at it, so these tests assert the exact membership
// reconciliation — what is added, what is removed, and what is captured for
// rollback before anything is touched.
// =============================================================================

import deploy from '../deploy'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
  leaksToken,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const ORN_GROUPS = 'orn:okta:directory:00o1:groups'
const ORN_USERS = 'orn:okta:directory:00o1:users'
const ORN_APPS = 'orn:okta:idp:00o1:apps'

function resourceSet(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Helpdesk scope',
    fields: {
      label: 'Helpdesk scope',
      description: 'What Tier 1 may touch',
      resources: [ORN_GROUPS, ORN_USERS],
      ...fields,
    },
  }
}

const LIVE_SET = {
  id: 'iamLIVE',
  label: 'Helpdesk scope',
  description: 'Old description',
}

function setsList(sets: unknown[]) {
  return ok({ 'resource-sets': sets })
}

function membership(id: string, orn: string) {
  return { id, orn, _links: { self: { href: `${API_BASE}/iam/resource-sets/iamLIVE/resources/${id}` } } }
}

function membershipsList(items: unknown[]) {
  return ok({ resources: items })
}

describe('resource-sets deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [resourceSet()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [resourceSet()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [resourceSet()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    const result = await withFetch([setsList([]), ok({ id: 'iamNEW' })], async (calls) => {
      const res = await deploy(deployContext({ sections: [resourceSet()] }))

      expect(calls[0].path).toBe('/iam/resource-sets')
      expect(calls[0].method).toBe('GET')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksToken(result)).toBe(false)
  })

  it('creates a set that does not exist, scoped to exactly the declared resources', async () => {
    await withFetch([setsList([]), ok({ id: 'iamNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [resourceSet()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/iam/resource-sets')
      expect(writes[0].json).toEqual({
        label: 'Helpdesk scope',
        description: 'What Tier 1 may touch',
        resources: [ORN_GROUPS, ORN_USERS],
      })
    })
  })

  it('de-duplicates the declared resource list before sending it', async () => {
    await withFetch([setsList([]), ok({ id: 'iamNEW' })], async (calls) => {
      await deploy(
        deployContext({ sections: [resourceSet({ resources: [ORN_GROUPS, ORN_GROUPS, ORN_USERS] })] }),
      )

      expect(writeCalls(calls)[0].json.resources).toEqual([ORN_GROUPS, ORN_USERS])
    })
  })

  it('records the created set so rollback can delete it', async () => {
    const result = await withFetch([setsList([]), ok({ id: 'iamNEW' })], async () =>
      deploy(deployContext({ sections: [resourceSet()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('iamNEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.previousState[0].priorResources).toBeUndefined()
    expect(rb.createdIds).toEqual(['iamNEW'])
  })

  it('fails rather than losing track of a set Okta created without returning an id', async () => {
    const result = await withFetch([setsList([]), ok({ label: 'Helpdesk scope' })], async () =>
      deploy(deployContext({ sections: [resourceSet()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('updates a set that already exists and captures its prior label, description and membership', async () => {
    const result = await withFetch(
      [
        setsList([LIVE_SET]),
        membershipsList([membership('mem-1', ORN_GROUPS), membership('mem-2', ORN_APPS)]),
        ok({ id: 'iamLIVE' }),
        ok({}), // PATCH additions
        ok({}), // DELETE the extra membership
      ],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [resourceSet()] }))

        // Membership is read BEFORE anything is changed.
        expect(calls[1].method).toBe('GET')
        expect(calls[1].path).toBe('/iam/resource-sets/iamLIVE/resources')
        expect(calls[1].query.limit).toBe('100')

        const writes = writeCalls(calls)
        expect(writes[0].method).toBe('PUT')
        expect(writes[0].path).toBe('/iam/resource-sets/iamLIVE')
        expect(writes[0].json).toEqual({
          label: 'Helpdesk scope',
          description: 'What Tier 1 may touch',
        })
        return res
      },
    )

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('iamLIVE')
    expect(entry.prior).toEqual({ label: 'Helpdesk scope', description: 'Old description' })
    expect(entry.priorResources).toEqual([ORN_GROUPS, ORN_APPS])
  })

  it('adds every missing resource in ONE patch and removes each extra by membership id', async () => {
    await withFetch(
      [
        setsList([LIVE_SET]),
        membershipsList([membership('mem-1', ORN_GROUPS), membership('mem-2', ORN_APPS)]),
        ok({ id: 'iamLIVE' }),
        ok({}),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [resourceSet()] }))
        expect(result.success).toBe(true)

        const patches = writeCalls(calls).filter((c) => c.method === 'PATCH')
        expect(patches).toHaveLength(1)
        expect(patches[0].path).toBe('/iam/resource-sets/iamLIVE/resources')
        expect(patches[0].json).toEqual({ additions: [ORN_USERS] })

        // The resource the canvas no longer declares is removed, keyed on the
        // MEMBERSHIP id — not on the target resource's own id.
        const removes = writeCalls(calls).filter((c) => c.method === 'DELETE')
        expect(removes).toHaveLength(1)
        expect(removes[0].path).toBe('/iam/resource-sets/iamLIVE/resources/mem-2')
      },
    )
  })

  it('leaves an already-correct membership entirely alone', async () => {
    await withFetch(
      [
        setsList([LIVE_SET]),
        membershipsList([membership('mem-1', ORN_GROUPS), membership('mem-2', ORN_USERS)]),
        ok({ id: 'iamLIVE' }),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [resourceSet()] }))

        expect(result.success).toBe(true)
        expect(writeCalls(calls)).toHaveLength(1)
        expect(calls.some((c) => c.path.endsWith('/resources'))).toBe(true)
        expect(writeCalls(calls).some((c) => c.method === 'PATCH')).toBe(false)
      },
    )
  })

  it('matches a resource declared in REST-URL form against its live membership', async () => {
    const href = `${API_BASE}/groups/00g1`
    await withFetch(
      [
        setsList([LIVE_SET]),
        membershipsList([{ id: 'mem-1', _links: { self: { href } } }]),
        ok({ id: 'iamLIVE' }),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [resourceSet({ resources: [href] })] }))

        expect(result.success).toBe(true)
        // No add and no remove: the URL form resolved to the existing membership.
        expect(writeCalls(calls)).toHaveLength(1)
      },
    )
  })

  it('tolerates a 404 when removing a membership that is already gone', async () => {
    await withFetch(
      [
        setsList([LIVE_SET]),
        membershipsList([
          membership('mem-1', ORN_GROUPS),
          membership('mem-2', ORN_USERS),
          membership('mem-3', ORN_APPS),
        ]),
        ok({ id: 'iamLIVE' }),
        notFound(),
      ],
      async () => {
        const result = await deploy(deployContext({ sections: [resourceSet()] }))
        expect(result.success).toBe(true)
      },
    )
  })

  it('cannot remove a membership Okta returned with no id, and says so by leaving it', async () => {
    await withFetch(
      [
        setsList([LIVE_SET]),
        membershipsList([membership('mem-1', ORN_GROUPS), membership('mem-2', ORN_USERS), { orn: ORN_APPS }]),
        ok({ id: 'iamLIVE' }),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [resourceSet()] }))

        expect(result.success).toBe(true)
        expect(writeCalls(calls).some((c) => c.method === 'DELETE')).toBe(false)
      },
    )
  })

  it('skips an incomplete section rather than creating an empty scope', async () => {
    await withFetch([setsList([])], async (calls) => {
      const result = await deploy(deployContext({ sections: [resourceSet({ resources: [] })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the set list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [resourceSet()] }))
      // A 403 on the read must never be mistaken for "no sets exist".
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list resource sets/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [setsList([]), apiError('Api validation failed: resources', 400, ['orn: malformed'])],
      async () => deploy(deployContext({ sections: [resourceSet()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create resource set/)
    expect(result.message).toMatch(/orn: malformed/)
  })

  it('returns a FAILED result when the membership read is rejected, before any write', async () => {
    const result = await withFetch(
      [setsList([LIVE_SET]), apiError('Insufficient permissions', 403)],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [resourceSet()] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list resources for resource set/)
  })

  it('returns a FAILED result when widening the scope is rejected, keeping the rollback state', async () => {
    const result = await withFetch(
      [
        setsList([LIVE_SET]),
        membershipsList([membership('mem-1', ORN_GROUPS)]),
        ok({ id: 'iamLIVE' }),
        apiError('Resource not found', 400),
      ],
      async () => deploy(deployContext({ sections: [resourceSet()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to add resources/)
    const rb = result.rollbackData as { previousState: Array<Record<string, unknown>> }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].priorResources).toEqual([ORN_GROUPS])
  })

  it('reports how far it got when a later set fails', async () => {
    const result = await withFetch(
      [setsList([]), ok({ id: 'iamONE' }), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [
              resourceSet(),
              { ...resourceSet({ label: 'Tier 2 scope' }), name: 'Tier 2 scope' },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { createdIds: string[]; previousState: unknown[] }
    expect(rb.createdIds).toEqual(['iamONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('lists the org resource sets once, not once per declared set', async () => {
    await withFetch([setsList([]), ok({ id: 'iamONE' }), ok({ id: 'iamTWO' })], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [resourceSet(), { ...resourceSet({ label: 'Tier 2 scope' }), name: 'Tier 2 scope' }],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls.filter((c) => c.path === '/iam/resource-sets' && c.method === 'GET')).toHaveLength(1)
    })
  })

  it('tolerates the platform failing to hand back the prior deploy', async () => {
    await withFetch([setsList([]), ok({ id: 'iamNEW' })], async () => {
      const result = await deploy(deployContext({ sections: [resourceSet()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('never touches a resource set the canvas does not declare', async () => {
    await withFetch(
      [setsList([LIVE_SET, { id: 'iamOTHER', label: 'Untouched' }]), ok({ id: 'x' })],
      async (calls) => {
        await deploy(deployContext({ sections: [resourceSet({ label: 'Brand New scope' })] }))
        expect(calls.some((c) => c.path.includes('iamOTHER'))).toBe(false)
        expect(calls.some((c) => c.path.includes('iamLIVE'))).toBe(false)
      },
    )
  })
})
