// =============================================================================
// sms-templates — driftDetect, driven against the fake Okta org.
//
// Drift here is the recovery SMS quietly saying something else: a rewritten body
// (critical — it is the defining field) or a translation added, dropped or
// reworded (a warning). Server-managed fields are never modeled, so a template
// Okta merely re-timestamped must never read as drift.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  EMPTY_LIST,
  apiError,
  driftContext,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const BODY = 'Your ${org.name} verification code is ${code}'
const SPANISH = 'Tu codigo de verificacion es ${code}'
const FRENCH = 'Votre code est ${code}'

function template(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Verification SMS',
    fields: { name: 'Acme verify', type: 'SMS_VERIFY_CODE', template: BODY, ...fields },
  }
}

const IN_SYNC = { id: 'sms-live', name: 'Acme verify', type: 'SMS_VERIFY_CODE', template: BODY }

describe('sms-templates driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [template()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [template()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean template as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [template()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/templates/sms')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, template: 'Rewritten ${code}' }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [template()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted template as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [template()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Acme verify')
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a rewritten body as critical — it is the defining field', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, template: 'Call 555-0100 with code ${code}' }])],
      async () => driftDetect(driftContext({ sections: [template()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Acme verify.template')
    expect(diff?.expected).toBe(BODY)
    expect(diff?.actual).toBe('Call 555-0100 with code ${code}')
    expect(diff?.severity).toBe('critical')
  })

  it('reports an emptied body as "not set" rather than as an empty string', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, template: '' }])], async () =>
      driftDetect(driftContext({ sections: [template()] })),
    )

    expect(result.diffs.find((d) => d.field === 'Acme verify.template')?.actual).toBe('not set')
  })

  it('flags a translation added out of band', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, translations: { fr: FRENCH } }])], async () =>
      driftDetect(driftContext({ sections: [template()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Acme verify.translations')
    expect(diff?.expected).toEqual({})
    expect(diff?.actual).toEqual({ fr: FRENCH })
    expect(diff?.severity).toBe('warning')
  })

  it('flags a translation that was dropped', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(
        driftContext({ sections: [template({ translationsJson: JSON.stringify({ es: SPANISH }) })] }),
      ),
    )

    const diff = result.diffs.find((d) => d.field === 'Acme verify.translations')
    expect(diff?.expected).toEqual({ es: SPANISH })
    expect(diff?.actual).toEqual({})
  })

  it('compares translations order-insensitively', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, translations: { fr: FRENCH, es: SPANISH } }])],
      async () =>
        driftDetect(
          driftContext({
            sections: [template({ translationsJson: JSON.stringify({ es: SPANISH, fr: FRENCH }) })],
          }),
        ),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('treats a malformed declared translations blob as no translations', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [template({ translationsJson: '{not json' })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('never reports the timestamps Okta manages as drift', async () => {
    const result = await withFetch(
      [
        ok([
          {
            ...IN_SYNC,
            created: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-09-09T00:00:00.000Z',
            _links: { self: { href: 'https://dev-12345.okta.com/api/v1/templates/sms/sms-live' } },
          },
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [template()] })),
    )

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('reports an unreadable template list as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [template()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('Acme verify')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps reporting the remaining templates after one is unreadable', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403), EMPTY_LIST], async () =>
      driftDetect(
        driftContext({
          sections: [
            template(),
            { name: 'Partner SMS', fields: { name: 'Partner verify', type: 'SMS_VERIFY_CODE', template: BODY } },
          ],
        }),
      ),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[1].field).toBe('Partner verify')
    expect(result.diffs[1].actual).toBe('missing')
  })
})
