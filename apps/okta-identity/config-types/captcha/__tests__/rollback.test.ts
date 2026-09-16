// =============================================================================
// captcha — rollback, driven against the fake Okta org.
//
// ORDER IS THE WHOLE POINT here: Okta refuses to delete a CAPTCHA instance the
// org-wide setting still references, so rollback restores the org settings FIRST
// (which detaches anything this deploy created) and only then deletes or restores
// the instance. The write-only secret key can never be put back, and the result
// says so rather than implying a clean revert.
// =============================================================================

import rollback from '../rollback'
import type { CaptchaRollbackData } from '../deploy'
import {
  API_TOKEN,
  apiError,
  emptyCredential,
  leaksToken,
  notFound,
  ok,
  rollbackContext,
  withFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeOkta'

const PRIOR_ORG = { captchaId: 'cap-old', enabledPages: ['SIGN_IN'] }

const PRIOR_INSTANCE = { name: 'Old CAPTCHA', type: 'RECAPTCHA_V2', siteKey: 'old-site-key' }

function createdState(overrides: Partial<CaptchaRollbackData> = {}): CaptchaRollbackData {
  return { instanceExisted: false, instanceId: 'cap-new', priorOrg: { ...PRIOR_ORG }, ...overrides }
}

function updatedState(overrides: Partial<CaptchaRollbackData> = {}): CaptchaRollbackData {
  return {
    instanceExisted: true,
    instanceId: 'cap-live',
    priorInstance: { ...PRIOR_INSTANCE },
    priorOrg: { ...PRIOR_ORG },
    ...overrides,
  }
}

describe('captcha rollback', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext(createdState(), { credential: null }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext(createdState(), { credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext(createdState(), { hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports there is nothing to roll back when the deploy recorded no state at all', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext(undefined))
      expect(result.success).toBe(false)
      expect(result.message).toBe('No previous state available for rollback')
      expect(calls).toHaveLength(0)
    })
  })

  it('reverts nothing, and says nothing was reverted, for an empty state object', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({}))
      expect(result.success).toBe(true)
      expect(result.message).toMatch(/nothing to revert/)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the org-wide settings BEFORE deleting the instance they reference', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext(createdState()))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)
      // Detach first — Okta will not delete a referenced instance.
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/org/captcha')
      expect(writes[0].json).toEqual(PRIOR_ORG)
      expect(writes[1].method).toBe('DELETE')
      expect(writes[1].path).toBe('/captchas/cap-new')
    })
  })

  it('restores a null org-wide binding exactly rather than skipping it', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext(createdState({ priorOrg: { captchaId: null, enabledPages: null } })),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json).toEqual({ captchaId: null, enabledPages: null })
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([ok({}), notFound()], async () => {
      const result = await rollback(rollbackContext(createdState()))
      expect(result.success).toBe(true)
    })
  })

  it('explains the reference that blocks a delete rather than forcing it', async () => {
    const result = await withFetch([ok({}), apiError('CAPTCHA is in use', 400)], async () =>
      rollback(rollbackContext(createdState())),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/CAPTCHA is in use/)
    expect(result.message).toMatch(/still referenced by the org-wide settings/)
    expect(result.message).toMatch(/1 step\(s\)/)
    expect(leaksToken(result)).toBe(false)
  })

  it('restores an instance that already existed and never deletes it', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(rollbackContext(updatedState()))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      const writes = writeCalls(calls)
      expect(writes[1].method).toBe('PUT')
      expect(writes[1].path).toBe('/captchas/cap-live')
      expect(writes[1].json).toEqual(PRIOR_INSTANCE)
    })
  })

  it('says the write-only secret key survives the rollback rather than implying a clean revert', async () => {
    const result = await withFetch([ok({}), ok({})], async () =>
      rollback(rollbackContext(updatedState())),
    )

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/secret key left unchanged/)
    expect(result.message).toMatch(/write-only/)
  })

  it('does nothing to an existing instance whose prior body was never captured', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext(updatedState({ priorInstance: undefined })))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/captchas'))).toBe(false)
    })
  })

  it('still restores the org settings when no instance id was recorded', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext(createdState({ instanceId: undefined })))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(1)
      expect(result.message).toMatch(/restored org-wide settings/)
    })
  })

  it('returns a FAILED result rather than throwing when the org restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await rollback(rollbackContext(createdState()))
      // The instance is left alone once the detach failed — deleting it now
      // would be rejected anyway, and forcing it is not rollback's job.
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore org-wide CAPTCHA settings/)
    expect(result.message).toMatch(/0 step\(s\)/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the instance restore is rejected', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext(updatedState())),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore CAPTCHA instance cap-live/)
    expect(result.message).toMatch(/1 step\(s\)/)
  })

  it('never puts the SSWS token in its success message', async () => {
    const result = await withFetch([ok({}), ok({})], async () =>
      rollback(rollbackContext(createdState())),
    )
    expect(result.success).toBe(true)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
