// =============================================================================
// email-domains — deploy, driven against the fake Okta org.
//
// This is the channel activation links and password resets travel down. A broken
// email domain does not error at anyone — it just quietly stops mail reaching
// people, which is why two things are asserted hardest here: a newly created
// domain is UNVERIFIED and deploy must SAY SO rather than auto-verify it, and the
// immutable fields (domain, brand, validation subdomain) must produce a loud
// delete-and-recreate error instead of a silently ignored change.
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

const LIVE_DOMAIN = {
  id: 'eml-live',
  domain: 'mail.acme.test',
  brandId: 'brd-1',
  displayName: 'Old Sender',
  userName: 'old-noreply',
  validationSubdomain: 'mail',
  validationStatus: 'VERIFIED',
}

interface EmailDomainRollback {
  previousState: Array<Record<string, unknown>>
  createdIds: string[]
}

describe('email-domains deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [emailDomain()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [emailDomain()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [emailDomain()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'eml-new' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [emailDomain()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates a domain that does not exist, carrying every field the create needs', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'eml-new' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [emailDomain()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/email-domains')
      expect(writes[0].json).toEqual({
        domain: 'mail.acme.test',
        brandId: 'brd-1',
        // The immutable subdomain defaults to "mail" rather than being omitted.
        validationSubdomain: 'mail',
        displayName: 'Acme Security',
        userName: 'no-reply',
      })
    })
  })

  it('surfaces the DNS handshake a new domain still owes instead of auto-verifying it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'eml-new' })], async (calls) => {
      const res = await deploy(deployContext({ sections: [emailDomain()] }))
      // Verification is an external one-time handshake — never called here.
      expect(calls.some((c) => c.path.includes('/verify'))).toBe(false)
      return res
    })

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/DNS verification required/)
    expect(result.message).toMatch(/does NOT auto-verify/)
    expect(result.message).toMatch(/dnsValidationRecords/)
    expect((result.artifacts as { needsVerify: string[] }).needsVerify).toEqual(['mail.acme.test'])
  })

  it('does not claim a DNS handshake is owed when nothing was created', async () => {
    const result = await withFetch([ok([LIVE_DOMAIN]), ok({})], async () =>
      deploy(deployContext({ sections: [emailDomain()] })),
    )

    expect(result.success).toBe(true)
    expect(result.message.includes('DNS verification required')).toBe(false)
    expect((result.artifacts as { needsVerify: string[] }).needsVerify).toEqual([])
  })

  it('records the created domain so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'eml-new' })], async () =>
      deploy(deployContext({ sections: [emailDomain()] })),
    )

    const rb = result.rollbackData as EmailDomainRollback
    expect(rb.createdIds).toEqual(['eml-new'])
    expect(rb.previousState).toEqual([{ domain: 'mail.acme.test', existed: false, id: 'eml-new' }])
  })

  it('fails loudly when a created domain comes back without an id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ domain: 'mail.acme.test' })], async () =>
      deploy(deployContext({ sections: [emailDomain()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('updates only the two sender fields Okta will accept, and captures the prior pair', async () => {
    const result = await withFetch([ok([LIVE_DOMAIN]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [emailDomain()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/email-domains/eml-live')
      // domain/brandId/validationSubdomain are immutable — never sent on a PUT.
      expect(writes[0].json).toEqual({ displayName: 'Acme Security', userName: 'no-reply' })
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as EmailDomainRollback).previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('eml-live')
    expect(entry.prior).toEqual({ displayName: 'Old Sender', userName: 'old-noreply' })
  })

  it('matches an existing domain case-insensitively rather than creating a second one', async () => {
    await withFetch([ok([{ ...LIVE_DOMAIN, domain: 'MAIL.ACME.TEST' }]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [emailDomain()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'POST')).toBe(false)
    })
  })

  it('matches a domain found on a later page of the paginated list', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'eml-other', domain: 'mail.partner.test' }],
          headers: { link: '<https://dev-12345.okta.com/api/v1/email-domains?after=eml-other>; rel="next"' },
        },
        ok([LIVE_DOMAIN]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [emailDomain()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('eml-other')
        expect(calls.some((c) => c.method === 'POST')).toBe(false)
        expect(writeCalls(calls)[0].path).toBe('/email-domains/eml-live')
      },
    )
  })

  it('refuses to silently ignore a brand change Okta cannot make in place', async () => {
    const result = await withFetch([ok([{ ...LIVE_DOMAIN, brandId: 'brd-other' }])], async (calls) => {
      const res = await deploy(deployContext({ sections: [emailDomain()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/brandId is immutable/)
    expect(result.message).toMatch(/Delete "mail\.acme\.test" and redeploy/)
  })

  it('refuses to silently ignore a validation-subdomain change Okta cannot make in place', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE_DOMAIN, validationSubdomain: 'okta-mail' }])],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [emailDomain()] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/validationSubdomain is immutable/)
  })

  it('does not read an immutable field Okta omitted as a conflict', async () => {
    await withFetch(
      [ok([{ id: 'eml-live', domain: 'mail.acme.test', displayName: 'Old Sender' }]), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [emailDomain()] }))

        expect(result.success).toBe(true)
        expect(writeCalls(calls)[0].path).toBe('/email-domains/eml-live')
      },
    )
  })

  it('compares the validation subdomain case-insensitively', async () => {
    await withFetch([ok([{ ...LIVE_DOMAIN, validationSubdomain: 'MAIL' }]), ok({})], async () => {
      const result = await deploy(deployContext({ sections: [emailDomain()] }))
      expect(result.success).toBe(true)
    })
  })

  it('returns a FAILED result rather than throwing when the domain list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [emailDomain()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list email domains/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Api validation failed: domain', 409, ['domain: already exists'])],
      async () => deploy(deployContext({ sections: [emailDomain()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create email domain "mail\.acme\.test"/)
    expect(result.message).toMatch(/already exists/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch([ok([LIVE_DOMAIN]), apiError('Insufficient permissions', 403)], async () =>
      deploy(deployContext({ sections: [emailDomain()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update email domain "mail\.acme\.test"/)
  })

  it('reports partial progress and keeps rollback state when a later domain fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'eml-one' }), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
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

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as EmailDomainRollback
    expect(rb.createdIds).toEqual(['eml-one'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('ignores a section that declares no domain', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [{ name: 'Blank', fields: { domain: '  ', brandId: 'brd-1' } }] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })
})
