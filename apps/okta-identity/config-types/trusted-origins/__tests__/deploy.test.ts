// =============================================================================
// trusted-origins — deploy, driven against the fake Okta org.
//
// A trusted origin tells Okta which web origins may call its API cross-origin,
// receive a post-sign-in redirect, or embed Okta in an iframe. An origin granted
// the wrong scope is a token-exfiltration path, so these tests pin the exact body
// sent, the scope expansion, the lifecycle reconciliation (status is NOT in the
// PUT body) and the prior definition captured before an update.
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

function origin(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Corp SPA',
    fields: {
      name: 'Corp SPA',
      origin: 'https://app.example.com',
      scopes: ['CORS', 'REDIRECT'],
      status: 'ACTIVE',
      ...fields,
    },
  }
}

const LIVE_ORIGIN = {
  id: 'tosLIVE',
  name: 'Corp SPA',
  origin: 'https://old.example.com',
  scopes: [{ type: 'CORS' }],
  status: 'ACTIVE',
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  createdBy: '00uADMIN',
  lastUpdatedBy: '00uADMIN',
  _links: { self: { href: `${API_BASE}/trustedOrigins/tosLIVE` } },
}

describe('trusted-origins deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [origin()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [origin()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [origin()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    const result = await withFetch([ok([]), ok({ id: 'tosNEW', status: 'ACTIVE' })], async (calls) => {
      const res = await deploy(deployContext({ sections: [origin()] }))

      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/trustedOrigins')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksToken(result)).toBe(false)
  })

  it('creates an origin that does not exist, granting exactly the declared scopes', async () => {
    await withFetch([ok([]), ok({ id: 'tosNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [origin()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/trustedOrigins')
      expect(writes[0].json).toEqual({
        name: 'Corp SPA',
        origin: 'https://app.example.com',
        scopes: [{ type: 'CORS' }, { type: 'REDIRECT' }],
      })
    })
  })

  it('never puts status in the body — lifecycle is a separate endpoint', async () => {
    await withFetch([ok([]), ok({ id: 'tosNEW', status: 'ACTIVE' }), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [origin({ status: 'INACTIVE' })] }))

      const create = writeCalls(calls)[0]
      expect(create.json.status).toBeUndefined()
      expect(writeCalls(calls)[1].path).toBe('/trustedOrigins/tosNEW/lifecycle/deactivate')
    })
  })

  it('normalises a trailing slash so the stored origin matches what Okta keeps', async () => {
    await withFetch([ok([]), ok({ id: 'tosNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [origin({ origin: 'https://app.example.com/' })] }))
      expect(writeCalls(calls)[0].json.origin).toBe('https://app.example.com')
    })
  })

  it('accepts a lower-case scope rather than silently dropping the grant', async () => {
    await withFetch([ok([]), ok({ id: 'tosNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [origin({ scopes: ['cors'] })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json.scopes).toEqual([{ type: 'CORS' }])
    })
  })

  it('records the created origin so rollback can delete it', async () => {
    const result = await withFetch([ok([]), ok({ id: 'tosNEW', status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [origin()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('tosNEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.previousState[0].priorStatus).toBeUndefined()
    expect(rb.createdIds).toEqual(['tosNEW'])
  })

  it('fails rather than losing track of an origin Okta created without returning an id', async () => {
    const result = await withFetch([ok([]), ok({ name: 'Corp SPA' })], async () =>
      deploy(deployContext({ sections: [origin()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('updates an origin that already exists and captures its prior definition', async () => {
    const result = await withFetch([ok([LIVE_ORIGIN]), ok({ id: 'tosLIVE' })], async (calls) => {
      const res = await deploy(deployContext({ sections: [origin()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/trustedOrigins/tosLIVE')
      expect(writes[0].json).toEqual({
        name: 'Corp SPA',
        origin: 'https://app.example.com',
        scopes: [{ type: 'CORS' }, { type: 'REDIRECT' }],
      })
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('tosLIVE')
    expect(entry.priorStatus).toBe('ACTIVE')
    // Server-managed fields are stripped so the captured body is safe to PUT back.
    expect(entry.prior).toEqual({
      name: 'Corp SPA',
      origin: 'https://old.example.com',
      scopes: [{ type: 'CORS' }],
    })
  })

  it('revokes a scope the canvas no longer grants', async () => {
    await withFetch(
      [ok([{ ...LIVE_ORIGIN, scopes: [{ type: 'CORS' }, { type: 'IFRAME_EMBED' }] }]), ok({ id: 'tosLIVE' })],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [origin({ scopes: ['CORS'] })] }))

        expect(result.success).toBe(true)
        // The PUT replaces the whole scope list — IFRAME_EMBED is gone.
        expect(writeCalls(calls)[0].json.scopes).toEqual([{ type: 'CORS' }])
      },
    )
  })

  it('changes a live origin lifecycle through the lifecycle endpoint', async () => {
    await withFetch([ok([LIVE_ORIGIN]), ok({ id: 'tosLIVE' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [origin({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes[1].method).toBe('POST')
      expect(writes[1].path).toBe('/trustedOrigins/tosLIVE/lifecycle/deactivate')
    })
  })

  it('leaves the lifecycle alone when the live status already matches', async () => {
    await withFetch([ok([LIVE_ORIGIN]), ok({ id: 'tosLIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [origin()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('reactivates an origin somebody deactivated out of band', async () => {
    await withFetch(
      [ok([{ ...LIVE_ORIGIN, status: 'INACTIVE' }]), ok({ id: 'tosLIVE' }), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [origin()] }))

        expect(result.success).toBe(true)
        expect(writeCalls(calls)[1].path).toBe('/trustedOrigins/tosLIVE/lifecycle/activate')
      },
    )
  })

  it('tolerates a 404 on the lifecycle transition', async () => {
    await withFetch([ok([LIVE_ORIGIN]), ok({ id: 'tosLIVE' }), notFound()], async () => {
      const result = await deploy(deployContext({ sections: [origin({ status: 'INACTIVE' })] }))
      expect(result.success).toBe(true)
    })
  })

  it('never deletes an origin — a matched origin is only ever updated in place', async () => {
    await withFetch([ok([LIVE_ORIGIN]), ok({ id: 'tosLIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [origin()] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('skips a section that grants no scope rather than creating a trust with nothing in it', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [origin({ scopes: [] })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('skips a section with no origin URL', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [origin({ origin: '' })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('follows the Link header so an origin on a later page is matched, not re-created', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'tosOTHER', name: 'Somewhere else' }],
          headers: { link: `<${API_BASE}/trustedOrigins?after=tosOTHER>; rel="next"` },
        },
        ok([LIVE_ORIGIN]),
        ok({ id: 'tosLIVE' }),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [origin()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('tosOTHER')
        expect(writeCalls(calls)[0].method).toBe('PUT')
        expect(writeCalls(calls)[0].path).toBe('/trustedOrigins/tosLIVE')
      },
    )
  })

  it('returns a FAILED result rather than throwing when the origin list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [origin()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a
      // create that duplicates a live trust.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list trusted origins/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [ok([]), apiError('Api validation failed: origin', 400, ['origin: must not have a path'])],
      async () => deploy(deployContext({ sections: [origin()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create trusted origin/)
    expect(result.message).toMatch(/must not have a path/)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_ORIGIN]), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [origin()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update trusted origin/)
    const rb = result.rollbackData as { previousState: Array<Record<string, unknown>> }
    // The prior definition was captured before the PUT was attempted.
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].priorStatus).toBe('ACTIVE')
  })

  it('returns a FAILED result when the lifecycle transition is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_ORIGIN]), ok({ id: 'tosLIVE' }), apiError('Cannot deactivate', 400)],
      async () => deploy(deployContext({ sections: [origin({ status: 'INACTIVE' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to deactivate trusted origin/)
  })

  it('reports how far it got when a later origin fails', async () => {
    const result = await withFetch(
      [ok([]), ok({ id: 'tosONE', status: 'ACTIVE' }), ok([]), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [origin(), { ...origin({ name: 'Partner SPA' }), name: 'Partner SPA' }],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { createdIds: string[]; previousState: unknown[] }
    expect(rb.createdIds).toEqual(['tosONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('tolerates the platform failing to hand back the prior deploy', async () => {
    await withFetch([ok([]), ok({ id: 'tosNEW', status: 'ACTIVE' })], async () => {
      const result = await deploy(deployContext({ sections: [origin()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('never writes to an origin the canvas does not declare', async () => {
    await withFetch(
      [ok([LIVE_ORIGIN, { id: 'tosOTHER', name: 'Untouched', status: 'ACTIVE' }]), ok({ id: 'tosLIVE' })],
      async (calls) => {
        await deploy(deployContext({ sections: [origin()] }))
        expect(writeCalls(calls).some((c) => c.path.includes('tosOTHER'))).toBe(false)
      },
    )
  })
})
