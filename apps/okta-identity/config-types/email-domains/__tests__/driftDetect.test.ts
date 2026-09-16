// =============================================================================
// email-domains — driftDetect, driven against the fake Okta org.
//
// Drift on a mail domain is somebody re-pointing where the org's activation and
// recovery mail comes from. The severities encode what an operator can DO about
// it: sender fields are a warning (a redeploy fixes them), the immutable brand
// and validation subdomain are critical (only delete-and-recreate can), and an
// unverified domain is a channel that is not actually sending yet.
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

function emailDomain(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Notification mail',
    fields: {
      domain: 'mail.acme.test',
      brandId: 'brd-1',
      displayName: 'Acme Security',
      userName: 'no-reply',
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: 'eml-live',
  domain: 'mail.acme.test',
  brandId: 'brd-1',
  displayName: 'Acme Security',
  userName: 'no-reply',
  validationSubdomain: 'mail',
  validationStatus: 'VERIFIED',
}

describe('email-domains driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [emailDomain()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [emailDomain()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean domain as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [emailDomain()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/email-domains')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, validationStatus: 'IN_PROGRESS' }])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [emailDomain()] }))
      expect(result.hasDrift).toBe(true)
      // In particular it never calls the verify handshake to "fix" the drift.
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted domain as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'mail.acme.test')
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a changed sender display name as a warning a redeploy can fix', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, displayName: 'Totally Legit Bank' }])], async () =>
      driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'mail.acme.test.displayName')
    expect(diff?.expected).toBe('Acme Security')
    expect(diff?.actual).toBe('Totally Legit Bank')
    expect(diff?.severity).toBe('warning')
  })

  it('flags a changed sender username and reports a cleared one as "not set"', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, userName: '' }])], async () =>
      driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'mail.acme.test.userName')
    expect(diff?.expected).toBe('no-reply')
    expect(diff?.actual).toBe('not set')
  })

  it('flags a re-pointed brand as critical — no redeploy can change it', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, brandId: 'brd-other' }])], async () =>
      driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'mail.acme.test.brandId')
    expect(diff?.expected).toBe('brd-1')
    expect(diff?.actual).toBe('brd-other')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a changed validation subdomain as critical', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, validationSubdomain: 'okta-mail' }])], async () =>
      driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'mail.acme.test.validationSubdomain')
    expect(diff?.expected).toBe('mail')
    expect(diff?.actual).toBe('okta-mail')
    expect(diff?.severity).toBe('critical')
  })

  it('compares the validation subdomain case-insensitively', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, validationSubdomain: 'MAIL' }])], async () =>
      driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.validationSubdomain'))).toHaveLength(0)
  })

  it('does not read an immutable field Okta omitted as drift', async () => {
    const result = await withFetch(
      [ok([{ id: 'eml-live', domain: 'mail.acme.test', displayName: 'Acme Security', userName: 'no-reply' }])],
      async () => driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a domain still owing the DNS handshake', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, validationStatus: 'NOT_STARTED' }])], async () =>
      driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'mail.acme.test.validationStatus')
    expect(diff?.expected).toBe('VERIFIED')
    expect(diff?.actual).toBe('NOT_STARTED')
    expect(diff?.severity).toBe('warning')
  })

  it('accepts COMPLETED as a verified domain', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, validationStatus: 'completed' }])], async () =>
      driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.validationStatus'))).toHaveLength(0)
  })

  it('never reports the runtime DNS records Okta returns as drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, dnsValidationRecords: [{ recordType: 'TXT', fqdn: 'mail.acme.test' }], _links: {} }])],
      async () => driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('reports an unreadable domain list as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [emailDomain()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('mail.acme.test')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps reporting the remaining domains after one is unreadable', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403), EMPTY_LIST], async () =>
      driftDetect(
        driftContext({
          sections: [
            emailDomain(),
            {
              name: 'Partner mail',
              fields: {
                domain: 'mail.partner.test',
                brandId: 'brd-2',
                displayName: 'Partner',
                userName: 'no-reply',
              },
            },
          ],
        }),
      ),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[1].field).toBe('mail.partner.test')
    expect(result.diffs[1].actual).toBe('missing')
  })
})
