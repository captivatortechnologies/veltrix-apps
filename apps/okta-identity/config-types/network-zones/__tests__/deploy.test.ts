// =============================================================================
// network-zones — deploy, driven against the fake Okta org.
//
// A network zone is a trust boundary: policies allow or block sign-in by it, so
// a CIDR written wrongly here either lets the internet in or locks the office
// out. These tests pin the body actually sent, the lifecycle reconciliation
// (status is NOT settable by PUT alone), the refusal to CREATE one of Okta's
// system zones, and the prior definition captured before an update.
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

const DECLARED_GATEWAYS = [{ type: 'CIDR', value: '203.0.113.0/24' }]

function zone(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Corp egress',
    fields: {
      name: 'Corp egress',
      type: 'IP',
      status: 'ACTIVE',
      configJson: JSON.stringify({ gateways: DECLARED_GATEWAYS }),
      ...fields,
    },
  }
}

const LIVE_ZONE = {
  id: 'nzoLIVE',
  name: 'Corp egress',
  type: 'IP',
  status: 'ACTIVE',
  system: false,
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  _links: { self: { href: `${API_BASE}/zones/nzoLIVE` } },
  gateways: [{ type: 'CIDR', value: '198.51.100.0/24' }],
}

describe('network-zones deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [zone()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [zone()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [zone()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    const result = await withFetch([ok([]), ok({ id: 'nzoNEW', status: 'ACTIVE' })], async (calls) => {
      const res = await deploy(deployContext({ sections: [zone()] }))

      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/zones')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksToken(result)).toBe(false)
  })

  it('creates a zone that does not exist, sending exactly the declared definition', async () => {
    await withFetch([ok([]), ok({ id: 'nzoNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [zone()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/zones')
      expect(writes[0].json).toEqual({
        gateways: DECLARED_GATEWAYS,
        type: 'IP',
        name: 'Corp egress',
        status: 'ACTIVE',
      })
    })
  })

  it('never lets the free-form definition override the zone identity', async () => {
    await withFetch([ok([]), ok({ id: 'nzoNEW', status: 'ACTIVE' })], async (calls) => {
      await deploy(
        deployContext({
          sections: [
            zone({
              configJson: JSON.stringify({
                gateways: DECLARED_GATEWAYS,
                name: 'BlockedIpZone',
                type: 'DYNAMIC',
                status: 'INACTIVE',
              }),
            }),
          ],
        }),
      )

      const body = writeCalls(calls)[0].json
      expect(body.name).toBe('Corp egress')
      expect(body.type).toBe('IP')
      expect(body.status).toBe('ACTIVE')
    })
  })

  it('records the created zone so rollback can delete it', async () => {
    const result = await withFetch([ok([]), ok({ id: 'nzoNEW', status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [zone()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('nzoNEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.previousState[0].priorStatus).toBeUndefined()
    expect(rb.createdIds).toEqual(['nzoNEW'])
  })

  it('deactivates a freshly created zone when INACTIVE was declared', async () => {
    await withFetch(
      [ok([]), ok({ id: 'nzoNEW', status: 'ACTIVE' }), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [zone({ status: 'INACTIVE' })] }))

        expect(result.success).toBe(true)
        // Okta creates a zone ACTIVE; status is not settable by the body alone.
        expect(writeCalls(calls)[1].path).toBe('/zones/nzoNEW/lifecycle/deactivate')
      },
    )
  })

  it('fails rather than losing track of a zone Okta created without returning an id', async () => {
    const result = await withFetch([ok([]), ok({ name: 'Corp egress' })], async () =>
      deploy(deployContext({ sections: [zone()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('updates a zone that already exists and captures its prior definition', async () => {
    const result = await withFetch([ok([LIVE_ZONE]), ok({ id: 'nzoLIVE' })], async (calls) => {
      const res = await deploy(deployContext({ sections: [zone()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/zones/nzoLIVE')
      expect(writes[0].json).toEqual({
        gateways: DECLARED_GATEWAYS,
        type: 'IP',
        name: 'Corp egress',
        status: 'ACTIVE',
      })
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('nzoLIVE')
    expect(entry.priorStatus).toBe('ACTIVE')
    // Server-managed fields are stripped so the captured body is safe to PUT back.
    expect(entry.prior).toEqual({
      name: 'Corp egress',
      type: 'IP',
      gateways: [{ type: 'CIDR', value: '198.51.100.0/24' }],
    })
  })

  it('changes a live zone lifecycle through the lifecycle endpoint, not the PUT body alone', async () => {
    await withFetch([ok([LIVE_ZONE]), ok({ id: 'nzoLIVE' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [zone({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes[1].method).toBe('POST')
      expect(writes[1].path).toBe('/zones/nzoLIVE/lifecycle/deactivate')
    })
  })

  it('leaves the lifecycle alone when the live status already matches', async () => {
    await withFetch([ok([LIVE_ZONE]), ok({ id: 'nzoLIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [zone()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('reactivates a zone somebody deactivated out of band', async () => {
    await withFetch(
      [ok([{ ...LIVE_ZONE, status: 'INACTIVE' }]), ok({ id: 'nzoLIVE' }), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [zone()] }))

        expect(result.success).toBe(true)
        expect(writeCalls(calls)[1].path).toBe('/zones/nzoLIVE/lifecycle/activate')
      },
    )
  })

  it('tolerates a 404 on the lifecycle transition', async () => {
    await withFetch([ok([LIVE_ZONE]), ok({ id: 'nzoLIVE' }), notFound()], async () => {
      const result = await deploy(deployContext({ sections: [zone({ status: 'INACTIVE' })] }))
      expect(result.success).toBe(true)
    })
  })

  it('refuses to CREATE one of Okta\'s protected system zones', async () => {
    const result = await withFetch([ok([])], async (calls) => {
      const res = await deploy(deployContext({ sections: [zone({ name: 'BlockedIpZone' })] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/protected Okta system zone/)
    expect(result.message).toMatch(/cannot be created/)
  })

  it('still updates a protected system zone in place where it already exists', async () => {
    await withFetch(
      [ok([{ ...LIVE_ZONE, name: 'BlockedIpZone', system: true }]), ok({ id: 'nzoLIVE' })],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [zone({ name: 'BlockedIpZone' })] }))

        expect(result.success).toBe(true)
        const writes = writeCalls(calls)
        expect(writes[0].method).toBe('PUT')
        // `system` is never echoed back into the update body.
        expect(writes[0].json.system).toBeUndefined()
      },
    )
  })

  it('never deletes a zone — a matched zone is only ever updated in place', async () => {
    await withFetch([ok([LIVE_ZONE]), ok({ id: 'nzoLIVE' })], async (calls) => {
      await deploy(deployContext({ sections: [zone({ type: 'DYNAMIC' })] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('refuses a malformed definition before it reaches the org', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [zone({ configJson: '{not json' })] }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/not a valid JSON object/)
  })

  it('treats an absent definition as an empty one rather than failing', async () => {
    await withFetch([ok([]), ok({ id: 'nzoNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [zone({ configJson: '' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json).toEqual({
        type: 'IP',
        name: 'Corp egress',
        status: 'ACTIVE',
      })
    })
  })

  it('skips a section with no name or no type rather than guessing', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [zone({ name: '' }), zone({ type: '' })] }),
      )
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('follows the Link header so a zone on a later page is matched, not re-created', async () => {
    await withFetch(
      [
        { status: 200, body: [{ id: 'nzoOTHER', name: 'Somewhere else' }], headers: { link: `<${API_BASE}/zones?after=nzoOTHER>; rel="next"` } },
        ok([LIVE_ZONE]),
        ok({ id: 'nzoLIVE' }),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [zone()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('nzoOTHER')
        expect(writeCalls(calls)[0].method).toBe('PUT')
        expect(writeCalls(calls)[0].path).toBe('/zones/nzoLIVE')
      },
    )
  })

  it('returns a FAILED result rather than throwing when the zone list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [zone()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a
      // create that duplicates a live trust boundary.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list zones/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [ok([]), apiError('Api validation failed: gateways', 400, ['value: not a CIDR'])],
      async () => deploy(deployContext({ sections: [zone()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create zone/)
    expect(result.message).toMatch(/value: not a CIDR/)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_ZONE]), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [zone()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update zone/)
    const rb = result.rollbackData as { previousState: Array<Record<string, unknown>> }
    // The prior definition was captured before the PUT was attempted.
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].priorStatus).toBe('ACTIVE')
  })

  it('returns a FAILED result when the lifecycle transition is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_ZONE]), ok({ id: 'nzoLIVE' }), apiError('Zone is in use', 400)],
      async () => deploy(deployContext({ sections: [zone({ status: 'INACTIVE' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to deactivate zone/)
  })

  it('reports how far it got when a later zone fails', async () => {
    const result = await withFetch(
      [ok([]), ok({ id: 'nzoONE', status: 'ACTIVE' }), ok([]), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [zone(), { ...zone({ name: 'Branch egress' }), name: 'Branch egress' }],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { createdIds: string[]; previousState: unknown[] }
    expect(rb.createdIds).toEqual(['nzoONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('tolerates the platform failing to hand back the prior deploy', async () => {
    await withFetch([ok([]), ok({ id: 'nzoNEW', status: 'ACTIVE' })], async () => {
      const result = await deploy(deployContext({ sections: [zone()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('never writes to a zone the canvas does not declare', async () => {
    await withFetch(
      [ok([LIVE_ZONE, { id: 'nzoOTHER', name: 'Untouched', status: 'ACTIVE' }]), ok({ id: 'nzoLIVE' })],
      async (calls) => {
        await deploy(deployContext({ sections: [zone()] }))
        expect(writeCalls(calls).some((c) => c.path.includes('nzoOTHER'))).toBe(false)
      },
    )
  })
})
