// =============================================================================
// custom-domains — deploy, driven against the fake Okta org.
//
// A custom domain IS the login URL the browser shows. Get it wrong and sign-in
// goes to a page nobody trusts — or to nothing at all. Two invariants carry the
// weight here: a newly created domain is born UNVERIFIED and this app must SAY SO
// rather than auto-verify it, and a domain already switched to a MANUAL
// certificate can never be reverted by API, so the handler must refuse loudly
// instead of silently ignoring the request.
// =============================================================================

import deploy from '../deploy'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

/**
 * Distinctive PEM material — no result may ever echo it back. The armour is
 * assembled at runtime so the fixture is byte-identical to a real PEM without a
 * private-key block literally sitting in a file the platform ships.
 */
const pem = (label: string, body: string): string =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`

const PRIVATE_KEY = pem('PRIVATE KEY', 'SUPERSECRET-domain-private-key')
const CERTIFICATE = pem('CERTIFICATE', 'leaf')
const CHAIN = pem('CERTIFICATE', 'chain')

function domain(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Login URL',
    fields: { domain: 'login.acme.test', certificateSourceType: 'OKTA_MANAGED', ...fields },
  }
}

function manualDomain(fields: Record<string, unknown> = {}): CanvasItemInput {
  return domain({
    certificateSourceType: 'MANUAL',
    certificate: CERTIFICATE,
    certificateChain: CHAIN,
    privateKey: PRIVATE_KEY,
    ...fields,
  })
}

/** A list response as Okta shapes it: an OBJECT with a `domains` array. */
function domainList(domains: unknown[]) {
  return ok({ domains })
}

const LIVE_DOMAIN = {
  id: 'dom-live',
  domain: 'login.acme.test',
  brandId: 'brd-1',
  certificateSourceType: 'OKTA_MANAGED',
  validationStatus: 'VERIFIED',
}

interface DomainRollback {
  previousState: Array<Record<string, unknown>>
  createdIds: string[]
}

function leaksPrivateKey(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes('SUPERSECRET-domain-private-key')
}

describe('custom-domains deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [domain()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [domain()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [domain()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([domainList([]), ok({ id: 'dom-new' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [domain()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates a domain that does not exist with only the two fields Okta accepts', async () => {
    await withFetch([domainList([]), ok({ id: 'dom-new' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [domain()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/domains')
      expect(writes[0].json).toEqual({ domain: 'login.acme.test', certificateSourceType: 'OKTA_MANAGED' })
    })
  })

  it('surfaces the DNS handshake a new domain still owes instead of auto-verifying it', async () => {
    const result = await withFetch([domainList([]), ok({ id: 'dom-new' })], async (calls) => {
      const res = await deploy(deployContext({ sections: [domain()] }))
      // The verify endpoint is an external one-time handshake — never called here.
      expect(calls.some((c) => c.path.includes('/verify'))).toBe(false)
      return res
    })

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/DNS verification required/)
    expect(result.message).toMatch(/does NOT auto-verify/)
    expect(result.message).toMatch(/dnsRecords/)
    expect((result.artifacts as { needsVerify: string[] }).needsVerify).toEqual(['login.acme.test'])
  })

  it('does not claim a DNS handshake is owed when nothing was created', async () => {
    const result = await withFetch([domainList([LIVE_DOMAIN])], async () =>
      deploy(deployContext({ sections: [domain({ brandId: 'brd-1' })] })),
    )

    expect(result.success).toBe(true)
    expect(result.message.includes('DNS verification required')).toBe(false)
    expect((result.artifacts as { needsVerify: string[] }).needsVerify).toEqual([])
  })

  it('records the created domain so rollback can delete it', async () => {
    const result = await withFetch([domainList([]), ok({ id: 'dom-new' })], async () =>
      deploy(deployContext({ sections: [domain()] })),
    )

    const rb = result.rollbackData as DomainRollback
    expect(rb.createdIds).toEqual(['dom-new'])
    expect(rb.previousState).toEqual([
      { domain: 'login.acme.test', existed: false, id: 'dom-new' },
    ])
  })

  it('fails loudly when a created domain comes back without an id', async () => {
    const result = await withFetch([domainList([]), ok({ domain: 'login.acme.test' })], async () =>
      deploy(deployContext({ sections: [domain()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('sets the manual certificate and then binds the brand on a newly created domain', async () => {
    const result = await withFetch(
      [domainList([]), ok({ id: 'dom-new' }), ok({}), ok({})],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [manualDomain({ brandId: 'brd-1' })] }))

        expect(res.success).toBe(true)
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(3)
        expect(writes[1].method).toBe('PUT')
        expect(writes[1].path).toBe('/domains/dom-new/certificate')
        expect(writes[1].json).toEqual({
          type: 'PEM',
          certificate: CERTIFICATE,
          certificateChain: CHAIN,
          privateKey: PRIVATE_KEY,
        })
        expect(writes[2].path).toBe('/domains/dom-new')
        expect(writes[2].json).toEqual({ brandId: 'brd-1' })
        return res
      },
    )

    expect(leaksPrivateKey(result)).toBe(false)
  })

  it('matches an existing domain case-insensitively rather than creating a second one', async () => {
    await withFetch([domainList([{ ...LIVE_DOMAIN, domain: 'LOGIN.ACME.TEST' }])], async (calls) => {
      const result = await deploy(deployContext({ sections: [domain({ brandId: 'brd-1' })] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'POST')).toBe(false)
    })
  })

  it('leaves an existing domain untouched when nothing it can change has changed', async () => {
    await withFetch([domainList([LIVE_DOMAIN])], async (calls) => {
      const result = await deploy(deployContext({ sections: [domain({ brandId: 'brd-1' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('rebinds the brand — the one field an existing domain can change', async () => {
    const result = await withFetch(
      [domainList([{ ...LIVE_DOMAIN, brandId: 'brd-old' }]), ok({})],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [domain({ brandId: 'brd-new' })] }))

        const writes = writeCalls(calls)
        expect(writes).toHaveLength(1)
        expect(writes[0].method).toBe('PUT')
        expect(writes[0].path).toBe('/domains/dom-live')
        expect(writes[0].json).toEqual({ brandId: 'brd-new' })
        return res
      },
    )

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as DomainRollback).previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('dom-live')
    expect(entry.priorBrandId).toBe('brd-old')
  })

  it('leaves the brand binding alone when the canvas declares none', async () => {
    await withFetch([domainList([{ ...LIVE_DOMAIN, brandId: 'brd-old' }])], async (calls) => {
      const result = await deploy(deployContext({ sections: [domain({ brandId: '' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('renews a manual certificate on every deploy — the upsert is idempotent', async () => {
    await withFetch(
      [domainList([{ ...LIVE_DOMAIN, certificateSourceType: 'MANUAL' }]), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [manualDomain({ brandId: 'brd-1' })] }))

        expect(result.success).toBe(true)
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(1)
        expect(writes[0].path).toBe('/domains/dom-live/certificate')
      },
    )
  })

  it('sends no certificate at all when the manual material is incomplete', async () => {
    await withFetch(
      [domainList([{ ...LIVE_DOMAIN, certificateSourceType: 'MANUAL' }])],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [domain({ certificateSourceType: 'MANUAL', certificate: CERTIFICATE, brandId: 'brd-1' })],
          }),
        )

        expect(result.success).toBe(true)
        expect(calls.some((c) => c.path.includes('/certificate'))).toBe(false)
      },
    )
  })

  it('refuses to silently ignore a MANUAL to OKTA_MANAGED revert Okta cannot perform', async () => {
    const result = await withFetch(
      [domainList([{ ...LIVE_DOMAIN, certificateSourceType: 'MANUAL' }])],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [domain({ brandId: 'brd-1' })] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/no API to revert a domain to OKTA_MANAGED/)
    expect(result.message).toMatch(/Delete "login\.acme\.test" and redeploy/)
  })

  it('returns a FAILED result rather than throwing when the domain list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [domain()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list custom domains/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [domainList([]), apiError('Api validation failed: domain', 400, ['domain: already registered'])],
      async () => deploy(deployContext({ sections: [domain()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create custom domain "login\.acme\.test"/)
    expect(result.message).toMatch(/already registered/)
  })

  it('returns a FAILED result rather than throwing when the certificate is rejected', async () => {
    const result = await withFetch(
      [domainList([]), ok({ id: 'dom-new' }), apiError('Certificate chain is invalid', 400)],
      async () => deploy(deployContext({ sections: [manualDomain()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to set certificate/)
    expect(result.message).toMatch(/Certificate chain is invalid/)
    // A rejected certificate must not put the private key into the failure log.
    expect(leaksPrivateKey(result)).toBe(false)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the brand rebind is rejected', async () => {
    const result = await withFetch(
      [domainList([{ ...LIVE_DOMAIN, brandId: 'brd-old' }]), apiError('Brand not found', 404)],
      async () => deploy(deployContext({ sections: [domain({ brandId: 'brd-new' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to rebind brand/)
    expect(result.message).toMatch(/Brand not found/)
  })

  it('reports partial progress and keeps rollback state when a later domain fails', async () => {
    const result = await withFetch(
      [domainList([]), ok({ id: 'dom-one' }), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [
              domain(),
              { name: 'Partner URL', fields: { domain: 'login.partner.test', certificateSourceType: 'OKTA_MANAGED' } },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as DomainRollback
    // The first domain WAS created — rollback must still be able to delete it.
    expect(rb.createdIds).toEqual(['dom-one'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('ignores a section that declares no domain', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [{ name: 'Blank', fields: { domain: '  ' } }] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })
})
