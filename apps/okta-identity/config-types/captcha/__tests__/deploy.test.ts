// =============================================================================
// captcha — deploy, driven against the fake Okta org.
//
// The CAPTCHA is the gate in front of sign-in, self-service reset and
// self-registration. An org holds AT MOST ONE instance, so there is no matching
// by name: deploy either updates the single instance or creates it, then sets the
// org-wide enablement — and an empty page list DISABLES the gate entirely, which
// is a security change, not a no-op.
//
// The provider secret key is WRITE-ONLY: Okta never returns it, so deploy must
// re-send it every time or it is cleared — and must never echo it back into a
// message, artifact or error, because deploy results are logged.
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

/** Distinctive provider secret — no result may ever echo it back. */
const SECRET_KEY = 'hcaptcha-SUPERSECRET-provider-secret'

function captcha(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Sign-in CAPTCHA',
    fields: {
      name: 'Acme hCaptcha',
      type: 'HCAPTCHA',
      siteKey: 'site-key-public',
      secretKey: SECRET_KEY,
      enabledPages: ['SIGN_IN'],
      ...fields,
    },
  }
}

const LIVE_INSTANCE = {
  id: 'cap-live',
  name: 'Old CAPTCHA',
  type: 'RECAPTCHA_V2',
  siteKey: 'old-site-key',
  _links: { self: { href: 'https://dev-12345.okta.com/api/v1/captchas/cap-live' } },
}

interface CaptchaRollback {
  instanceExisted: boolean
  instanceId?: string
  priorInstance?: Record<string, unknown>
  priorOrg?: { captchaId: string | null; enabledPages: string[] | null }
}

function leaksSecret(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes('SUPERSECRET-provider-secret')
}

describe('captcha deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [captcha()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
    expect(leaksSecret(result)).toBe(false)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [captcha()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [captcha()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses before touching the org when the canvas declares no CAPTCHA', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [] }))
      expect(result.success).toBe(false)
      expect(result.message).toBe('No CAPTCHA configuration provided')
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses a half-declared CAPTCHA rather than deploying a broken gate', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [captcha({ siteKey: '' })] }))
      expect(result.success).toBe(false)
      expect(result.message).toBe('No CAPTCHA configuration provided')
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([ok({}), EMPTY_LIST, ok({ id: 'cap-new' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [captcha()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(calls[0].path).toBe('/org/captcha')
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates the instance when the org has none, carrying the write-only secret', async () => {
    await withFetch([ok({}), EMPTY_LIST, ok({ id: 'cap-new' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [captcha()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/captchas')
      expect(writes[0].json).toEqual({
        name: 'Acme hCaptcha',
        type: 'HCAPTCHA',
        siteKey: 'site-key-public',
        secretKey: SECRET_KEY,
      })
    })
  })

  it('replaces the single existing instance rather than creating a second one', async () => {
    const result = await withFetch([ok({}), ok([LIVE_INSTANCE]), ok({}), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [captcha()] }))

      expect(res.success).toBe(true)
      expect(calls.some((c) => c.method === 'POST')).toBe(false)
      const writes = writeCalls(calls)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/captchas/cap-live')
      // The secret is re-asserted on a replace — omitting it would clear it.
      expect(writes[0].json.secretKey).toBe(SECRET_KEY)
      return res
    })

    const rb = result.rollbackData as CaptchaRollback
    expect(rb.instanceExisted).toBe(true)
    expect(rb.instanceId).toBe('cap-live')
    // Server-managed fields are stripped so the restore PUT is legal.
    expect(rb.priorInstance).toEqual({
      name: 'Old CAPTCHA',
      type: 'RECAPTCHA_V2',
      siteKey: 'old-site-key',
    })
  })

  it('binds the instance org-wide on the pages the canvas declares', async () => {
    await withFetch([ok({}), EMPTY_LIST, ok({ id: 'cap-new' }), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [captcha({ enabledPages: ['SIGN_IN', 'SSPR'] })] }),
      )

      expect(result.success).toBe(true)
      const orgPut = writeCalls(calls)[1]
      expect(orgPut.method).toBe('PUT')
      expect(orgPut.path).toBe('/org/captcha')
      expect(orgPut.json).toEqual({ captchaId: 'cap-new', enabledPages: ['SIGN_IN', 'SSPR'] })
      expect(result.message).toMatch(/enabled on SIGN_IN, SSPR/)
    })
  })

  it('normalises and de-duplicates the declared pages', async () => {
    await withFetch([ok({}), EMPTY_LIST, ok({ id: 'cap-new' }), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [captcha({ enabledPages: 'sign_in, sspr, SIGN_IN' })] }))

      expect(writeCalls(calls)[1].json.enabledPages).toEqual(['SIGN_IN', 'SSPR'])
    })
  })

  it('DISABLES the gate org-wide when no pages are declared, and says so', async () => {
    const result = await withFetch([ok({}), EMPTY_LIST, ok({ id: 'cap-new' }), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [captcha({ enabledPages: [] })] }))

      const orgPut = writeCalls(calls)[1]
      expect(orgPut.json).toEqual({ captchaId: null, enabledPages: null })
      return res
    })

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/configured but disabled org-wide/)
  })

  it('captures the org-wide settings BEFORE changing them so rollback can restore them', async () => {
    const result = await withFetch(
      [ok({ captchaId: 'cap-old', enabledPages: ['SIGN_IN', 'SSR'] }), EMPTY_LIST, ok({ id: 'cap-new' }), ok({})],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [captcha()] }))
        // The capture happens first — before the instance is even looked up.
        expect(calls[0].path).toBe('/org/captcha')
        expect(calls[0].method).toBe('GET')
        return res
      },
    )

    const rb = result.rollbackData as CaptchaRollback
    expect(rb.priorOrg).toEqual({ captchaId: 'cap-old', enabledPages: ['SIGN_IN', 'SSR'] })
    expect(rb.instanceExisted).toBe(false)
    expect(rb.instanceId).toBe('cap-new')
  })

  it('records nulls when the org had no CAPTCHA configured at all', async () => {
    const result = await withFetch([ok({}), EMPTY_LIST, ok({ id: 'cap-new' }), ok({})], async () =>
      deploy(deployContext({ sections: [captcha()] })),
    )

    const rb = result.rollbackData as CaptchaRollback
    expect(rb.priorOrg).toEqual({ captchaId: null, enabledPages: null })
  })

  it('never puts the provider secret in its result', async () => {
    const result = await withFetch([ok({}), EMPTY_LIST, ok({ id: 'cap-new' }), ok({})], async () =>
      deploy(deployContext({ sections: [captcha()] })),
    )

    expect(result.success).toBe(true)
    expect(leaksSecret(result)).toBe(false)
    expect(leaksToken(result)).toBe(false)
    expect(result.artifacts).toEqual({
      baseUrl: 'https://dev-12345.okta.com',
      instanceId: 'cap-new',
      enabledPages: ['SIGN_IN'],
    })
  })

  it('returns a FAILED result rather than throwing when the org settings cannot be read', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [captcha()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to read org-wide CAPTCHA settings/)
    expect(leaksSecret(result)).toBe(false)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the instance list is rejected', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [captcha()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a create.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list CAPTCHA instances/)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [ok({}), EMPTY_LIST, apiError('Api validation failed: secretKey', 400, ['secretKey: invalid'])],
      async () => deploy(deployContext({ sections: [captcha()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create CAPTCHA instance "Acme hCaptcha"/)
    expect(result.message).toMatch(/secretKey: invalid/)
    // A secret-related rejection must not put the secret itself in the log.
    expect(leaksSecret(result)).toBe(false)
  })

  it('fails loudly when a created instance comes back without an id', async () => {
    const result = await withFetch([ok({}), EMPTY_LIST, ok({ name: 'Acme hCaptcha' })], async () =>
      deploy(deployContext({ sections: [captcha()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('returns a FAILED result rather than throwing when the org-wide update is rejected', async () => {
    const result = await withFetch(
      [ok({}), ok([LIVE_INSTANCE]), ok({}), apiError('Insufficient permissions', 403)],
      async () => deploy(deployContext({ sections: [captcha()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update org-wide CAPTCHA settings/)
    expect(leaksSecret(result)).toBe(false)
  })

  it('deploys only the first declared CAPTCHA — an org holds exactly one', async () => {
    await withFetch([ok({}), EMPTY_LIST, ok({ id: 'cap-new' }), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [captcha(), captcha({ name: 'Second CAPTCHA', siteKey: 'second-site-key' })],
        }),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      expect(writes[0].json.name).toBe('Acme hCaptcha')
    })
  })
})
