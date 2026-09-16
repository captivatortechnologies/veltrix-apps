// =============================================================================
// sms-templates — deploy, driven against the fake Okta org.
//
// This is the text of the SMS that carries an enrolment or recovery code. A
// template deployed with a broken macro or a truncated body does not fail at
// deploy time — it fails later, per person, as an SMS nobody can act on. There is
// no upsert, so the tests assert the list-and-match decision, the exact body sent
// (a PUT is a FULL REPLACE), the failure contract and the rollback state.
// =============================================================================

import deploy from '../deploy'
import {
  API_BASE,
  API_TOKEN,
  EMPTY_LIST,
  apiError,
  deployContext,
  emptyCredential,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const BODY = 'Your ${org.name} verification code is ${code}'
const SPANISH = 'Tu codigo de verificacion es ${code}'

function template(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Verification SMS',
    fields: { name: 'Acme verify', type: 'SMS_VERIFY_CODE', template: BODY, ...fields },
  }
}

const LIVE_TEMPLATE = {
  id: 'sms-live',
  name: 'Acme verify',
  type: 'SMS_VERIFY_CODE',
  template: 'Old body ${code}',
  translations: { es: 'Viejo ${code}' },
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  _links: { self: { href: 'https://dev-12345.okta.com/api/v1/templates/sms/sms-live' } },
}

interface SmsRollback {
  previousState: Array<Record<string, unknown>>
  createdIds: string[]
}

describe('sms-templates deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [template()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [template()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [template()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'sms-new' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [template()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates a template that does not exist', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'sms-new' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [template()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/templates/sms')
      // No translations key at all — an omitted block is not sent as {}.
      expect(writes[0].json).toEqual({ name: 'Acme verify', type: 'SMS_VERIFY_CODE', template: BODY })
    })
  })

  it('sends declared translations alongside the body', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'sms-new' })], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [template({ translationsJson: JSON.stringify({ es: SPANISH }) })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json.translations).toEqual({ es: SPANISH })
    })
  })

  it('records the created template so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'sms-new' })], async () =>
      deploy(deployContext({ sections: [template()] })),
    )

    const rb = result.rollbackData as SmsRollback
    expect(rb.createdIds).toEqual(['sms-new'])
    expect(rb.previousState).toEqual([{ name: 'Acme verify', existed: false, id: 'sms-new' }])
  })

  it('fails loudly when a created template comes back without an id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ name: 'Acme verify' })], async () =>
      deploy(deployContext({ sections: [template()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('full-replaces a template that already exists and captures its prior body', async () => {
    const result = await withFetch([ok([LIVE_TEMPLATE]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [template()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/templates/sms/sms-live')
      expect(writes[0].json).toEqual({ name: 'Acme verify', type: 'SMS_VERIFY_CODE', template: BODY })
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as SmsRollback).previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('sms-live')
    // Server-managed fields are stripped so the restore PUT is legal.
    expect(entry.prior).toEqual({
      name: 'Acme verify',
      type: 'SMS_VERIFY_CODE',
      template: 'Old body ${code}',
      translations: { es: 'Viejo ${code}' },
    })
  })

  it('matches the template name exactly — a differently-cased name is a different template', async () => {
    await withFetch([ok([{ ...LIVE_TEMPLATE, name: 'ACME VERIFY' }]), ok({ id: 'sms-new' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [template()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].method).toBe('POST')
    })
  })

  it('matches a template found on a later page of the paginated list', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'sms-other', name: 'Partner verify' }],
          headers: { link: '<https://dev-12345.okta.com/api/v1/templates/sms?after=sms-other>; rel="next"' },
        },
        ok([LIVE_TEMPLATE]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [template()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('sms-other')
        expect(calls.some((c) => c.method === 'POST')).toBe(false)
        expect(writeCalls(calls)[0].path).toBe('/templates/sms/sms-live')
      },
    )
  })

  it('refuses a malformed translations blob before touching the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [template({ translationsJson: '{not json' })] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/translations is not a valid JSON object of strings/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses a translations blob whose values are not strings', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [template({ translationsJson: '{"es": 42}' })] }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/not a valid JSON object of strings/)
      expect(calls).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the template list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [template()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list SMS templates/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Api validation failed: template', 400, ['template: too long'])],
      async () => deploy(deployContext({ sections: [template()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create SMS template "Acme verify"/)
    expect(result.message).toMatch(/too long/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the replace is rejected', async () => {
    const result = await withFetch([ok([LIVE_TEMPLATE]), apiError('Insufficient permissions', 403)], async () =>
      deploy(deployContext({ sections: [template()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update SMS template "Acme verify"/)
  })

  it('reports partial progress and keeps rollback state when a later template fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'sms-one' }), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [
              template(),
              {
                name: 'Partner SMS',
                fields: { name: 'Partner verify', type: 'SMS_VERIFY_CODE', template: BODY },
              },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as SmsRollback
    // The first template WAS created — rollback must still be able to delete it.
    expect(rb.createdIds).toEqual(['sms-one'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('ignores a section that declares no template name', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [{ name: 'Blank', fields: { name: '  ', template: BODY } }] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads and writes only the SMS template routes', async () => {
    await withFetch([ok([LIVE_TEMPLATE]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [template()] }))

      for (const call of calls) {
        expect(call.path.startsWith('/templates/sms')).toBe(true)
      }
    })
  })
})
