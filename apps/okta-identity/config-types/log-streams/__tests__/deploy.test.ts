// =============================================================================
// log-streams — deploy, driven against the fake Okta org.
//
// A log stream is the pipe that carries the org's System Log off-box. If it is
// never created, silently deactivated, or pointed at the wrong destination, the
// audit trail ends without anything failing loudly. Two Okta constraints shape
// this handler: `type` and `settings` are WRITE-ONCE, and the Splunk HEC token is
// write-only and create-only. Both are asserted here, along with the exact body
// sent and the guarantee that no secret is echoed back.
// =============================================================================

import deploy from '../deploy'
import type { LiveLogStream } from '../validate'
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

/** The Splunk HEC token — a write-only secret that must never surface in a result. */
const HEC_TOKEN = 'splunk-hec-SUPERSECRET-token'

const AWS_SETTINGS = {
  accountId: '123456789012',
  eventSourceName: 'okta-events',
  region: 'us-east-1',
}

function leaksSecret(value: unknown): boolean {
  try {
    return JSON.stringify(value ?? null).includes(HEC_TOKEN)
  } catch {
    return String(value).includes(HEC_TOKEN)
  }
}

function stream(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Audit export',
    fields: {
      name: 'Veltrix audit export',
      type: 'aws_eventbridge',
      status: 'ACTIVE',
      settingsJson: JSON.stringify(AWS_SETTINGS),
      ...fields,
    },
  }
}

function splunkStream(fields: Record<string, unknown> = {}): CanvasItemInput {
  return stream({
    type: 'splunk_cloud_logstreaming',
    settingsJson: JSON.stringify({ host: 'http-inputs-acme.splunkcloud.com', edition: 'aws' }),
    splunkToken: HEC_TOKEN,
    ...fields,
  })
}

const LIVE_STREAM: LiveLogStream = {
  id: 'lsLIVE',
  name: 'Veltrix audit export',
  type: 'aws_eventbridge',
  status: 'ACTIVE',
  settings: { ...AWS_SETTINGS },
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  _links: { self: { href: `${API_BASE}/logStreams/lsLIVE` } },
}

describe('log-streams deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [stream()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [stream()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [stream()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and leaks no secret back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'lsNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [splunkStream()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
      expect(leaksSecret(result)).toBe(false)
    })
  })

  it('creates a stream that does not exist, sending the exact body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'lsNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [stream()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/logStreams')

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/logStreams')
      expect(writes[0].json).toEqual({
        type: 'aws_eventbridge',
        name: 'Veltrix audit export',
        settings: AWS_SETTINGS,
      })
      // status is lifecycle-managed and must never appear in the body.
      expect(writes[0].json.status).toBeUndefined()
    })
  })

  it('records the created stream so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'lsNEW', status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [stream()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('lsNEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.createdIds).toEqual(['lsNEW'])
  })

  it('fails rather than inventing an id when the create returns none', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ status: 'ACTIVE' })], async () =>
      deploy(deployContext({ sections: [stream()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('sends the Splunk HEC token on create only — it is write-only and create-only', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'lsNEW', status: 'ACTIVE' })], async (calls) => {
      const created = await deploy(deployContext({ sections: [splunkStream()] }))

      expect(created.success).toBe(true)
      const settings = writeCalls(calls)[0].json.settings as Record<string, unknown>
      expect(settings.token).toBe(HEC_TOKEN)
      expect(settings.host).toBe('http-inputs-acme.splunkcloud.com')
    })

    const liveSplunk: LiveLogStream = {
      ...LIVE_STREAM,
      type: 'splunk_cloud_logstreaming',
      settings: { host: 'http-inputs-acme.splunkcloud.com', edition: 'aws' },
    }
    await withFetch([ok([liveSplunk]), ok(liveSplunk)], async (calls) => {
      const updated = await deploy(deployContext({ sections: [splunkStream()] }))

      expect(updated.success).toBe(true)
      const settings = writeCalls(calls)[0].json.settings as Record<string, unknown>
      // The update settings schema has no token — sending it would be rejected.
      expect(settings.token).toBeUndefined()
      expect(leaksSecret(updated)).toBe(false)
    })
  })

  it('refuses to create a Splunk stream with no HEC token and writes nothing', async () => {
    const result = await withFetch([EMPTY_LIST], async (calls) => {
      const res = await deploy(deployContext({ sections: [splunkStream({ splunkToken: '' })] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Splunk HEC token/)
  })

  it('strips a stray token key out of the settings blob', async () => {
    await withFetch([ok([LIVE_STREAM]), ok(LIVE_STREAM)], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [stream({ settingsJson: JSON.stringify({ ...AWS_SETTINGS, token: HEC_TOKEN }) })],
        }),
      )

      expect(result.success).toBe(true)
      const settings = writeCalls(calls)[0].json.settings as Record<string, unknown>
      expect(settings.token).toBeUndefined()
      expect(leaksSecret(result)).toBe(false)
    })
  })

  it('updates a stream that already exists instead of creating a second one', async () => {
    await withFetch([ok([LIVE_STREAM]), ok(LIVE_STREAM)], async (calls) => {
      const result = await deploy(deployContext({ sections: [stream()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/logStreams/lsLIVE')
      expect(calls.some((c) => c.method === 'POST' && c.path === '/logStreams')).toBe(false)
    })
  })

  it('captures the prior body with server-managed fields stripped so it is safe to PUT back', async () => {
    const result = await withFetch([ok([LIVE_STREAM]), ok(LIVE_STREAM)], async () =>
      deploy(deployContext({ sections: [stream()] })),
    )

    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('lsLIVE')
    expect(entry.priorStatus).toBe('ACTIVE')
    expect(entry.prior).toEqual({
      name: LIVE_STREAM.name,
      type: LIVE_STREAM.type,
      settings: LIVE_STREAM.settings,
    })
  })

  it('refuses a destination-type change up front — type is immutable in Okta', async () => {
    const result = await withFetch([ok([LIVE_STREAM])], async (calls) => {
      const res = await deploy(
        deployContext({
          sections: [
            stream({
              type: 'splunk_cloud_logstreaming',
              settingsJson: JSON.stringify({ host: 'h', edition: 'aws' }),
              splunkToken: HEC_TOKEN,
            }),
          ],
        }),
      )
      // Better a clear refusal than a generic Okta writeOnce rejection — and no
      // write may be attempted.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/destination type is immutable/)
    expect(result.message).toMatch(/Delete and recreate/)
  })

  it('explains the immutability rule when Okta rejects the update', async () => {
    const result = await withFetch(
      [ok([LIVE_STREAM]), apiError('Property cannot be updated: settings', 400)],
      async () => deploy(deployContext({ sections: [stream()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Property cannot be updated/)
    expect(result.message).toMatch(/type and settings are immutable/)
  })

  it('reconciles status through the lifecycle endpoint, not the body', async () => {
    await withFetch([ok([LIVE_STREAM]), ok(LIVE_STREAM), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [stream({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json.status).toBeUndefined()
      expect(calls.some((c) => c.path === '/logStreams/lsLIVE/lifecycle/deactivate')).toBe(true)
    })
  })

  it('re-activates a stream somebody switched off', async () => {
    await withFetch(
      [ok([{ ...LIVE_STREAM, status: 'INACTIVE' }]), ok(LIVE_STREAM), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [stream({ status: 'ACTIVE' })] }))

        expect(result.success).toBe(true)
        expect(calls.some((c) => c.path === '/logStreams/lsLIVE/lifecycle/activate')).toBe(true)
      },
    )
  })

  it('makes no lifecycle call when the live status already matches', async () => {
    await withFetch([ok([LIVE_STREAM]), ok(LIVE_STREAM)], async (calls) => {
      await deploy(deployContext({ sections: [stream({ status: 'ACTIVE' })] }))
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('treats a 404 on the lifecycle transition as the stream already being gone', async () => {
    await withFetch(
      [ok([LIVE_STREAM]), ok(LIVE_STREAM), { status: 404, body: { errorSummary: 'Not found' } }],
      async () => {
        const result = await deploy(deployContext({ sections: [stream({ status: 'INACTIVE' })] }))
        expect(result.success).toBe(true)
      },
    )
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Api validation failed: settings', 400, ['region: invalid'])],
      async () => deploy(deployContext({ sections: [stream()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Api validation failed/)
    expect(result.message).toMatch(/region: invalid/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result and writes nothing when the stream list cannot be read', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [stream()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list log streams/)
    expect(result.message).toMatch(/Insufficient permissions/)
  })

  it('refuses a malformed settings blob before sending anything to the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [stream({ settingsJson: '[1,2,3]' })] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/not a valid JSON object/)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports partial progress and keeps rollback state when a later stream fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'lsONE', status: 'ACTIVE' }), EMPTY_LIST, apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [stream(), { name: 'Second', fields: { ...stream({ name: 'Second export' }).fields } }],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['lsONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('follows pagination so a stream on a later page is updated, not duplicated', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'lsOTHER', name: 'Someone else' }],
          headers: { link: `<${API_BASE}/logStreams?after=lsOTHER>; rel="next"` },
        },
        ok([LIVE_STREAM]),
        ok(LIVE_STREAM),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [stream()] }))

        expect(result.success).toBe(true)
        expect(calls.filter((c) => c.method === 'GET' && c.path === '/logStreams')).toHaveLength(2)
        expect(writeCalls(calls)[0].path).toBe('/logStreams/lsLIVE')
      },
    )
  })

  it('ignores a section with no name, type or settings rather than sending a broken body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'lsNEW', status: 'ACTIVE' })], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            stream(),
            { name: 'No settings', fields: { name: 'Bare', type: 'aws_eventbridge' } },
            { name: 'No type', fields: { name: 'Typeless', settingsJson: '{}' } },
          ],
        }),
      )

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/Deployed 1 log stream/)
      expect(writeCalls(calls)).toHaveLength(1)
    })
  })

  it('does not depend on the platform data API to resolve streams', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'lsNEW', status: 'ACTIVE' })], async () => {
      const result = await deploy(deployContext({ sections: [stream()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })
})
