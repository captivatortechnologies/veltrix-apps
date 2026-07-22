import validate, {
  extractUserSpecs,
  normalizeStatus,
  USER_STATUSES,
} from '../validate'
import { buildProfileBody, reconcileLifecycle } from '../deploy'
import type { OktaClient } from '../../../lib/okta'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; id?: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'users',
    canvas: { id: 'snap-1', canvasId: 'c1', version: 1, name: 'Users', toolType: 'okta-identity', entityType: 'users', sections },
    platform: stubPlatform,
  } as unknown as PipelineContext
}

const validUser = (over: Record<string, unknown> = {}) => ({
  login: 'svc-bot@acme.com',
  email: 'svc-bot@acme.com',
  firstName: 'Service',
  lastName: 'Bot',
  status: 'STAGED',
  ...over,
})

describe('Okta Users Validate Handler', () => {
  it('accepts a valid user', async () => {
    const res = await validate(makeCtx([{ name: 'User 1', fields: validUser() }]))
    expect(res.valid).toBe(true)
    expect(res.errors.length).toBe(0)
  })

  it('requires login, email, firstName, lastName', async () => {
    const res = await validate(makeCtx([{ name: 'User 1', fields: {} }]))
    expect(res.valid).toBe(false)
    const requiredCount = res.errors.filter((e) => e.code === 'required').length
    expect(requiredCount >= 3).toBe(true)
  })

  it('rejects an invalid email', async () => {
    const res = await validate(makeCtx([{ name: 'User 1', fields: validUser({ email: 'nope' }) }]))
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })

  it('flags a duplicate login (case-insensitive)', async () => {
    const res = await validate(
      makeCtx([
        { name: 'User 1', fields: validUser() },
        { name: 'User 2', fields: validUser({ login: 'SVC-BOT@ACME.COM' }) },
      ]),
    )
    expect(res.errors.some((e) => e.code === 'duplicate_user')).toBe(true)
  })

  it('warns (not errors) when a user is set to DEACTIVATED', async () => {
    const res = await validate(makeCtx([{ name: 'User 1', fields: validUser({ status: 'DEACTIVATED' }) }]))
    expect(res.valid).toBe(true)
    expect(res.warnings.some((w) => w.code === 'user_will_deactivate')).toBe(true)
  })
})

describe('extractUserSpecs / normalizeStatus', () => {
  it('carries the section id as the rename-safe itemId', () => {
    const specs = extractUserSpecs({ sections: [{ name: 'U', id: 'sec-1', fields: validUser() }] } as never)
    expect(specs[0].itemId).toBe('sec-1')
  })
  it('defaults an unknown status to STAGED', () => {
    expect(normalizeStatus('whatever')).toBe('STAGED')
    for (const s of USER_STATUSES) expect(normalizeStatus(s)).toBe(s)
  })
})

describe('buildProfileBody', () => {
  it('sends required fields and nulls omitted optional attributes (so they clear on update)', () => {
    const body = buildProfileBody({ ...validUser(), sendActivationEmail: false, sectionName: 'U' } as never)
    const profile = (body as { profile: Record<string, unknown> }).profile
    expect(profile.login).toBe('svc-bot@acme.com')
    expect(profile.displayName).toBeNull()
    expect(profile.title).toBeNull()
  })
})

// A mock client that records the lifecycle path it was asked to POST.
function recordingClient(): { client: OktaClient; calls: string[] } {
  const calls: string[] = []
  const client = {
    request: async (_method: string, path: string) => {
      calls.push(path)
      return { status: 200, ok: true, body: '{}', nextUrl: null }
    },
  } as unknown as OktaClient
  return { client, calls }
}

describe('reconcileLifecycle (safe transitions, never deletes)', () => {
  it('activates a STAGED user when desired ACTIVE', async () => {
    const { client, calls } = recordingClient()
    const warn = await reconcileLifecycle(client, 'u1', 'a@b.com', 'STAGED', 'ACTIVE', false)
    expect(warn).toBeNull()
    expect(calls.some((p) => p.includes('/lifecycle/activate'))).toBe(true)
  })

  it('unsuspends a SUSPENDED user when desired ACTIVE', async () => {
    const { client, calls } = recordingClient()
    await reconcileLifecycle(client, 'u1', 'a@b.com', 'SUSPENDED', 'ACTIVE', false)
    expect(calls.some((p) => p.includes('/lifecycle/unsuspend'))).toBe(true)
  })

  it('deactivates when desired DEACTIVATED', async () => {
    const { client, calls } = recordingClient()
    await reconcileLifecycle(client, 'u1', 'a@b.com', 'ACTIVE', 'DEACTIVATED', false)
    expect(calls.some((p) => p.includes('/lifecycle/deactivate'))).toBe(true)
  })

  it('does NOT call any lifecycle op when already in the desired state', async () => {
    const { client, calls } = recordingClient()
    const warn = await reconcileLifecycle(client, 'u1', 'a@b.com', 'ACTIVE', 'ACTIVE', false)
    expect(warn).toBeNull()
    expect(calls.length).toBe(0)
  })

  it('warns (does not force) when asked to suspend a non-active user', async () => {
    const { client, calls } = recordingClient()
    const warn = await reconcileLifecycle(client, 'u1', 'a@b.com', 'STAGED', 'SUSPENDED', false)
    expect(warn).toMatch(/cannot be suspended directly/)
    expect(calls.length).toBe(0)
  })
})
