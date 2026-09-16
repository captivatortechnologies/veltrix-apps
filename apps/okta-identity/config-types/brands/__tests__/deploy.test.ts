// =============================================================================
// brands — deploy, driven against the fake Okta org.
//
// A brand IS the sign-in page every person in the org meets: its name, its
// colours, its privacy policy, the email domain its messages come from. There is
// no upsert, so deploy has to list, match by name, and choose between create and
// update — get that wrong and you either fork a second brand nobody sees or
// overwrite the org's default login page. The tests below assert the request
// sequence, the exact bodies sent, the failure contract and the rollback state.
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

function brand(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Corporate sign-in',
    fields: { name: 'Acme', removePoweredByOkta: true, ...fields },
  }
}

const LIVE_BRAND = {
  id: 'brd-live',
  name: 'Acme',
  isDefault: true,
  removePoweredByOkta: false,
  customPrivacyPolicyUrl: null,
  agreeToCustomPrivacyPolicy: false,
  locale: 'en',
  _links: { self: { href: 'https://dev-12345.okta.com/api/v1/brands/brd-live' } },
}

const LIVE_THEME = {
  id: 'thm-1',
  primaryColorHex: '#000000',
  primaryColorContrastHex: '#ffffff',
  secondaryColorHex: '#111111',
  secondaryColorContrastHex: '#eeeeee',
  logo: 'https://cdn.example.test/logo.png',
  signInPageTouchPointVariant: 'OKTA_DEFAULT',
  _links: { self: { href: 'https://dev-12345.okta.com/api/v1/brands/brd-live/themes/thm-1' } },
}

interface BrandRollback {
  previousState: Array<Record<string, unknown>>
  createdIds: string[]
}

describe('brands deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [brand()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [brand()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [brand()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'brd-new' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [brand()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates a brand that does not exist, minimally first, then applies its settings', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'brd-new' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [brand({ locale: 'en' })] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)

      // POST /brands accepts ONLY a name — anything more is rejected by Okta.
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/brands')
      expect(writes[0].json).toEqual({ name: 'Acme' })

      expect(writes[1].method).toBe('PUT')
      expect(writes[1].path).toBe('/brands/brd-new')
      expect(writes[1].json).toEqual({
        name: 'Acme',
        removePoweredByOkta: true,
        agreeToCustomPrivacyPolicy: false,
        locale: 'en',
      })
    })
  })

  it('records the created brand so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'brd-new' }), ok({})], async () =>
      deploy(deployContext({ sections: [brand()] })),
    )

    const rb = result.rollbackData as BrandRollback
    expect(rb.createdIds).toEqual(['brd-new'])
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('brd-new')
    expect(rb.previousState[0].priorBrand).toBeUndefined()
  })

  it('fails loudly when a created brand comes back without an id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ name: 'Acme' })], async () =>
      deploy(deployContext({ sections: [brand()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('updates a brand that already exists and captures its prior body', async () => {
    const result = await withFetch([ok([LIVE_BRAND]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [brand()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/brands/brd-live')
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as BrandRollback).previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('brd-live')
    // Server-managed fields are stripped so the restore PUT is legal.
    expect(entry.priorBrand).toEqual({
      name: 'Acme',
      removePoweredByOkta: false,
      customPrivacyPolicyUrl: null,
      agreeToCustomPrivacyPolicy: false,
      locale: 'en',
    })
  })

  it('updates the default brand in place and never creates or deletes it', async () => {
    await withFetch([ok([LIVE_BRAND]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [brand()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(calls.some((c) => c.method === 'POST')).toBe(false)
    })
  })

  it('matches a brand found on a later page of the paginated brand list', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'brd-other', name: 'Partner portal' }],
          headers: { link: '<https://dev-12345.okta.com/api/v1/brands?after=brd-other>; rel="next"' },
        },
        ok([LIVE_BRAND]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [brand()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('brd-other')
        // Found on page two — so it is updated, not forked into a second brand.
        expect(calls.some((c) => c.method === 'POST')).toBe(false)
        expect(writeCalls(calls)[0].path).toBe('/brands/brd-live')
      },
    )
  })

  it('leaves the theme alone when the canvas declares no theme change', async () => {
    await withFetch([ok([LIVE_BRAND]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [brand()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/themes'))).toBe(false)
    })
  })

  it('reconciles the theme and never clears a colour the canvas left blank', async () => {
    const result = await withFetch(
      [ok([LIVE_BRAND]), ok({}), ok([LIVE_THEME]), ok({})],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [brand({ primaryColorHex: '#1662dd' })] }))

        expect(res.success).toBe(true)
        const themePut = writeCalls(calls)[1]
        expect(themePut.path).toBe('/brands/brd-live/themes/thm-1')
        // The declared colour is applied; the three the canvas left blank fall
        // back to the live theme rather than being blanked by the full replace.
        expect(themePut.json).toEqual({
          primaryColorHex: '#1662dd',
          primaryColorContrastHex: '#ffffff',
          secondaryColorHex: '#111111',
          secondaryColorContrastHex: '#eeeeee',
        })
        return res
      },
    )

    const entry = (result.rollbackData as BrandRollback).previousState[0]
    expect(entry.themeId).toBe('thm-1')
    // The binary assets Okta manages are never replayed back at it.
    expect(entry.priorTheme).toEqual({
      primaryColorHex: '#000000',
      primaryColorContrastHex: '#ffffff',
      secondaryColorHex: '#111111',
      secondaryColorContrastHex: '#eeeeee',
      signInPageTouchPointVariant: 'OKTA_DEFAULT',
    })
  })

  it('merges the declared touchpoint variants into the theme body', async () => {
    await withFetch([ok([LIVE_BRAND]), ok({}), ok([LIVE_THEME]), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [brand({ themeConfigJson: '{"signInPageTouchPointVariant":"BACKGROUND_IMAGE"}' })],
        }),
      )

      expect(result.success).toBe(true)
      const themePut = writeCalls(calls)[1]
      expect(themePut.json.signInPageTouchPointVariant).toBe('BACKGROUND_IMAGE')
      expect(themePut.json.primaryColorHex).toBe('#000000')
    })
  })

  it('refuses a malformed theme-variants blob before touching the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [brand({ themeConfigJson: '[1,2]' })] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/not a valid JSON object/)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails rather than inventing a theme when the brand has none', async () => {
    const result = await withFetch(
      [ok([LIVE_BRAND]), ok({}), EMPTY_LIST],
      async () => deploy(deployContext({ sections: [brand({ primaryColorHex: '#1662dd' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/has no theme to update/)
  })

  it('returns a FAILED result rather than throwing when the brand list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [brand()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list brands/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_BRAND]), apiError('Api validation failed: locale', 400, ['locale: not supported'])],
      async () => deploy(deployContext({ sections: [brand()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update brand "Acme"/)
    expect(result.message).toMatch(/not supported/)
    expect(leaksToken(result)).toBe(false)
  })

  it('records the new brand id even when applying its settings then fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'brd-new' }), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [brand()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to apply settings to new brand "Acme"/)
    // The brand IS live in the org at this point — its id has to survive the failure.
    expect((result.rollbackData as BrandRollback).createdIds).toEqual(['brd-new'])
  })

  it('returns a FAILED result rather than throwing when the theme update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE_BRAND]), ok({}), ok([LIVE_THEME]), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [brand({ primaryColorHex: '#1662dd' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update theme for brand "Acme"/)
  })

  it('reports partial progress and keeps rollback state when a later brand fails', async () => {
    const result = await withFetch(
      [
        ok([LIVE_BRAND]),
        ok({}),
        ok([LIVE_BRAND]),
        apiError('Insufficient permissions', 403),
      ],
      async () =>
        deploy(
          deployContext({
            sections: [brand(), { name: 'Partner sign-in', fields: { name: 'Partner' } }],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as BrandRollback
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].id).toBe('brd-live')
  })

  it('ignores a section that declares no brand name', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [{ name: 'Blank', fields: { name: '  ' } }] }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads and writes only the brands the canvas declares', async () => {
    await withFetch([ok([LIVE_BRAND]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [brand()] }))

      for (const call of calls) {
        expect(call.path === '/brands' || call.path === '/brands/brd-live').toBe(true)
      }
    })
  })
})
