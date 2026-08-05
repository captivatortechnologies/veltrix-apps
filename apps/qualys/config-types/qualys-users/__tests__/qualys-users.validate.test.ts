import validate, { extractUserSpecs, userKey } from '../validate'
import { buildAddParams, buildEditParams, parseUserBlock, userWriteError } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const FULL_FIELDS = {
  email: 'chris@example.com',
  first_name: 'Chris',
  last_name: 'Washington',
  job_title: 'Security Consultant',
  user_role: 'scanner',
  business_unit: 'Unassigned',
  address1: '500 Charles Avenue',
  city: 'New York',
  country: 'United States of America',
  state: 'New York',
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'qualys',
    customerId: 'cust-1',
    configTypeId: 'qualys-users',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'qualys',
      entityType: 'qualys-users',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Qualys Users Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete user', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: FULL_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing required fields', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { email: 'x@example.com' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('first_name'))).toBe(true)
    expect(result.errors.some((e) => e.field.includes('user_role'))).toBe(true)
    expect(result.errors.some((e) => e.field.includes('address1'))).toBe(true)
  })

  it('rejects an unsupported user role', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...FULL_FIELDS, user_role: 'superadmin' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects asset_groups for manager/unit_manager roles', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { ...FULL_FIELDS, user_role: 'manager', asset_groups: 'East Coast' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_combination')).toBe(true)
  })

  it('allows asset_groups for scanner/reader/contact roles', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...FULL_FIELDS, asset_groups: 'East Coast' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate emails case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: FULL_FIELDS },
        { name: 'b', fields: { ...FULL_FIELDS, email: 'Chris@Example.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_user')).toBe(true)
  })

  it('userKey lowercases and trims', () => {
    expect(userKey({ email: ' Chris@Example.com ' })).toBe(userKey({ email: 'chris@example.com' }))
  })

  it('buildAddParams includes add-only fields and omits blank optionals', () => {
    const spec = extractUserSpecs(makeCtx([{ name: 't', fields: FULL_FIELDS }]).canvas)[0]
    const params = buildAddParams(spec)
    expect(params.action).toBe('add')
    expect(params.user_role).toBe('scanner')
    expect(params.business_unit).toBe('Unassigned')
    expect(params.email).toBe('chris@example.com')
    expect(params.send_email).toBe(1)
    expect(params.asset_groups).toBeUndefined()
  })

  it('buildEditParams never includes user_role, business_unit or send_email', () => {
    const spec = extractUserSpecs(makeCtx([{ name: 't', fields: FULL_FIELDS }]).canvas)[0]
    const params = buildEditParams(spec, 'acme_cw4')
    expect(params.action).toBe('edit')
    expect(params.login).toBe('acme_cw4')
    expect((params as Record<string, unknown>).user_role).toBeUndefined()
    expect((params as Record<string, unknown>).business_unit).toBeUndefined()
    expect((params as Record<string, unknown>).send_email).toBeUndefined()
  })

  it('parseUserBlock defensively tries multiple candidate tag names', () => {
    const viaUserLogin = parseUserBlock('<USER_LOGIN>acme_cw4</USER_LOGIN><EMAIL>chris@example.com</EMAIL><FIRSTNAME>Chris</FIRSTNAME>')
    expect(viaUserLogin.login).toBe('acme_cw4')
    expect(viaUserLogin.email).toBe('chris@example.com')
    expect(viaUserLogin.firstName).toBe('Chris')

    const viaLogin = parseUserBlock('<LOGIN>acme_cw4</LOGIN><EMAIL>chris@example.com</EMAIL>')
    expect(viaLogin.login).toBe('acme_cw4')
  })

  it('userWriteError reads the RETURN status attribute, not a CODE element', () => {
    const success = {
      status: 200,
      ok: true,
      body: '<USER_OUTPUT><RETURN status="SUCCESS"><MESSAGE>user created</MESSAGE></RETURN></USER_OUTPUT>',
    }
    expect(userWriteError(success)).toBeNull()

    const failure = {
      status: 200,
      ok: true,
      body: '<USER_OUTPUT><RETURN status="FAILED"><MESSAGE>Invalid email</MESSAGE></RETURN></USER_OUTPUT>',
    }
    expect(userWriteError(failure)).toBe('Invalid email')
  })
})
