// =============================================================================
// custom-domains — driftDetect, driven against the fake Okta org.
//
// The dangerous drift on a login URL is not cosmetic: a domain switched to a
// MANUAL certificate in the Okta console can never be reverted by API, and a
// domain sitting UNVERIFIED is a login page that does not actually serve. Both
// must be REPORTED — and never "fixed" by a write from a detector.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  apiError,
  driftContext,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function domain(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Login URL',
    fields: { domain: 'login.acme.test', certificateSourceType: 'OKTA_MANAGED', ...fields },
  }
}

function domainList(domains: unknown[]) {
  return ok({ domains })
}

const IN_SYNC = {
  id: 'dom-live',
  domain: 'login.acme.test',
  brandId: 'brd-1',
  certificateSourceType: 'OKTA_MANAGED',
  validationStatus: 'VERIFIED',
}

describe('custom-domains driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [domain()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [domain()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean domain as in sync', async () => {
    const result = await withFetch([domainList([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [domain({ brandId: 'brd-1' })] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/domains')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([domainList([{ ...IN_SYNC, validationStatus: 'IN_PROGRESS' }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [domain({ brandId: 'brd-1' })] }))
      expect(result.hasDrift).toBe(true)
      // In particular it never calls the verify handshake to "fix" the drift.
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted domain as critical drift', async () => {
    const result = await withFetch([domainList([])], async () =>
      driftDetect(driftContext({ sections: [domain()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'login.acme.test')
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags an out-of-band switch to a MANUAL certificate as critical', async () => {
    const result = await withFetch(
      [domainList([{ ...IN_SYNC, certificateSourceType: 'MANUAL' }])],
      async () => driftDetect(driftContext({ sections: [domain({ brandId: 'brd-1' })] })),
    )

    const diff = result.diffs.find((d) => d.field === 'login.acme.test.certificateSourceType')
    expect(diff?.expected).toBe('OKTA_MANAGED')
    expect(diff?.actual).toBe('MANUAL')
    // There is no API to revert this, so it needs an operator, not a redeploy.
    expect(diff?.severity).toBe('critical')
  })

  it('flags a re-pointed brand as a warning, since a redeploy can fix it', async () => {
    const result = await withFetch([domainList([{ ...IN_SYNC, brandId: 'brd-other' }])], async () =>
      driftDetect(driftContext({ sections: [domain({ brandId: 'brd-1' })] })),
    )

    const diff = result.diffs.find((d) => d.field === 'login.acme.test.brandId')
    expect(diff?.expected).toBe('brd-1')
    expect(diff?.actual).toBe('brd-other')
    expect(diff?.severity).toBe('warning')
  })

  it('does not read a brand Okta did not return as drift', async () => {
    const result = await withFetch(
      [domainList([{ id: 'dom-live', domain: 'login.acme.test', certificateSourceType: 'OKTA_MANAGED', validationStatus: 'VERIFIED' }])],
      async () => driftDetect(driftContext({ sections: [domain({ brandId: 'brd-1' })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a domain still owing the DNS handshake', async () => {
    const result = await withFetch(
      [domainList([{ ...IN_SYNC, validationStatus: 'NOT_STARTED' }])],
      async () => driftDetect(driftContext({ sections: [domain({ brandId: 'brd-1' })] })),
    )

    const diff = result.diffs.find((d) => d.field === 'login.acme.test.validationStatus')
    expect(diff?.expected).toBe('VERIFIED')
    expect(diff?.actual).toBe('NOT_STARTED')
    expect(diff?.severity).toBe('warning')
  })

  it('accepts COMPLETED as a verified domain', async () => {
    const result = await withFetch(
      [domainList([{ ...IN_SYNC, validationStatus: 'completed' }])],
      async () => driftDetect(driftContext({ sections: [domain({ brandId: 'brd-1' })] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.validationStatus'))).toHaveLength(0)
  })

  it('never reports write-only certificate material as drift', async () => {
    const result = await withFetch(
      [
        domainList([
          {
            ...IN_SYNC,
            publicCertificate: { expiration: '2027-01-01', fingerprint: 'ab:cd', subject: 'CN=login.acme.test' },
          },
        ]),
      ],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              domain({
                brandId: 'brd-1',
                certificate: `-----BEGIN ${'CERTIFICATE'}-----`,
                privateKey: `-----BEGIN ${'PRIVATE KEY'}-----`,
              }),
            ],
          }),
        ),
    )

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('reports an unreadable domain list as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [domain()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('login.acme.test')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps reporting the remaining domains after one is unreadable', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403), domainList([])], async () =>
      driftDetect(
        driftContext({
          sections: [
            domain(),
            { name: 'Partner URL', fields: { domain: 'login.partner.test', certificateSourceType: 'OKTA_MANAGED' } },
          ],
        }),
      ),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[1].field).toBe('login.partner.test')
    expect(result.diffs[1].actual).toBe('missing')
  })
})
