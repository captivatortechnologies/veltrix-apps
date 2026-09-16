// =============================================================================
// app-group-assignments — deploy, driven against the fake Okta org.
//
// An app-group assignment IS the access grant: binding a group to an application
// gives every member of that group the app. The identity is the (appId, groupId)
// PAIR carried in the REST path, never in the body — so a free-form profile can
// never re-point the assignment. The other guarantee that matters is that a
// deploy never prunes an assignment it did not declare; unassigning a group
// nobody asked it to touch takes an app away from everyone in it.
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

function assignment(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Engineering gets Salesforce',
    fields: { appId: '0oaAPP', groupId: '00gENG', ...fields },
  }
}

const LIVE_ASSIGNMENT = {
  id: '00gENG',
  priority: 5,
  profile: { role: 'user' },
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  _links: { self: { href: 'https://example.test' } },
  _embedded: { group: { id: '00gENG' } },
}

describe('app-group-assignments deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [assignment()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [assignment()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [assignment()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([notFound(), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [assignment()] }))

      expect(calls[0].path).toBe('/apps/0oaAPP/groups/00gENG')
      expect(calls[0].method).toBe('GET')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(result.success).toBe(true)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('reads the assignment before writing it so rollback knows it created it', async () => {
    const result = await withFetch([notFound(), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [assignment()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/apps/0oaAPP/groups/00gENG')
      return res
    })

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0]).toEqual({ appId: '0oaAPP', groupId: '00gENG', existed: false })
    expect(rb.previousState[0].prior).toBeUndefined()
    // Assignments have no separate created id — the pair IS the identity.
    expect(rb.createdIds).toEqual([])
  })

  it('captures the prior body of an existing assignment, minus the server fields', async () => {
    const result = await withFetch([ok(LIVE_ASSIGNMENT), ok({})], async () =>
      deploy(deployContext({ sections: [assignment({ priority: 10 })] })),
    )

    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    // id / created / lastUpdated / _links / _embedded are server-managed and must
    // never be replayed on a PUT.
    expect(entry.prior).toEqual({ priority: 5, profile: { role: 'user' } })
  })

  it('sends only the authored fields in the assign body', async () => {
    await withFetch([notFound(), ok({})], async (calls) => {
      await deploy(
        deployContext({
          sections: [assignment({ priority: 3, profileJson: '{"role":"admin"}' })],
        }),
      )

      expect(writeCalls(calls)[0].json).toEqual({ priority: 3, profile: { role: 'admin' } })
    })
  })

  it('assigns with an empty body when neither priority nor profile is authored', async () => {
    await withFetch([notFound(), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [assignment()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json).toEqual({})
    })
  })

  it('sends a priority of 0 rather than treating it as blank', async () => {
    await withFetch([notFound(), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [assignment({ priority: 0 })] }))
      expect(writeCalls(calls)[0].json).toEqual({ priority: 0 })
    })
  })

  it('reads a priority authored as a string, as the canvas stores it', async () => {
    await withFetch([notFound(), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [assignment({ priority: '7' })] }))
      expect(writeCalls(calls)[0].json).toEqual({ priority: 7 })
    })
  })

  it('omits an unparseable profile rather than sending a broken body', async () => {
    await withFetch([notFound(), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [assignment({ profileJson: 'not json' })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json).toEqual({})
    })
  })

  it('never lets a free-form profile re-point the assignment', async () => {
    await withFetch([notFound(), ok({})], async (calls) => {
      await deploy(
        deployContext({
          sections: [assignment({ profileJson: '{"id":"00gEVIL","appId":"0oaEVIL"}' })],
        }),
      )

      const write = writeCalls(calls)[0]
      // The identity lives in the path; the profile is only ever nested.
      expect(write.path).toBe('/apps/0oaAPP/groups/00gENG')
      expect(write.json.id).toBeUndefined()
      expect(write.json.appId).toBeUndefined()
      expect(write.json.profile).toEqual({ id: '00gEVIL', appId: '0oaEVIL' })
    })
  })

  it('returns a FAILED result rather than throwing when the read is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [assignment()] }))
      // A 403 on the read must not be mistaken for "not assigned" and written over.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to fetch assignment/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the assign is rejected', async () => {
    const result = await withFetch(
      [notFound(), apiError('Api validation failed', 400, ['group: not found'])],
      async () => deploy(deployContext({ sections: [assignment()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/0 of 1/)
    expect(result.message).toMatch(/Failed to assign group to app "0oaAPP:00gENG"/)
    expect(result.message).toMatch(/group: not found/)
  })

  it('reports partial progress and keeps rollback state when a later assignment fails', async () => {
    const result = await withFetch(
      [notFound(), ok({}), notFound(), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [
              assignment(),
              { ...assignment({ groupId: '00gSALES' }), name: 'Sales gets Salesforce' },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    // Both entries are recorded — the second was read before its assign failed.
    const rb = result.rollbackData as { previousState: Array<Record<string, unknown>> }
    expect(rb.previousState).toHaveLength(2)
    expect(rb.previousState[1].groupId).toBe('00gSALES')
  })

  it('never lists or prunes assignments it did not declare', async () => {
    await withFetch([ok(LIVE_ASSIGNMENT), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [assignment()] }))

      // No enumeration of the app's other groups, and nothing is unassigned.
      expect(calls.some((c) => c.path === '/apps/0oaAPP/groups')).toBe(false)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      for (const call of calls) expect(call.path).toBe('/apps/0oaAPP/groups/00gENG')
    })
  })

  it('skips a section missing an app id or a group id', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [assignment({ appId: '' }), assignment({ groupId: '  ' })] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('does not depend on the platform data API to resolve an assignment', async () => {
    await withFetch([notFound(), ok({})], async () => {
      const result = await deploy(deployContext({ sections: [assignment()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })
})
