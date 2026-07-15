import validate, {
  checkPolicyHcl,
  extractPolicySpecs,
  isDefaultPolicy,
  isRootPolicy,
  normalizePolicy,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'policies',
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

const VALID_HCL = 'path "secret/data/app/*" {\n  capabilities = ["read", "list"]\n}'

describe('Vault ACL Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid policy', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { name: 'app-read', policy: VALID_HCL } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { policy: VALID_HCL } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing policy body', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'app-read' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('policy'))).toBe(true)
  })

  it('rejects a name with invalid characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'bad name!', policy: VALID_HCL } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects the reserved "root" policy', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'root', policy: VALID_HCL } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('rejects "root" case-insensitively', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'ROOT', policy: VALID_HCL } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('allows "default" but warns about it', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'default', policy: VALID_HCL } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'default_policy')).toBe(true)
  })

  it('rejects HCL with unbalanced braces', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'app-read', policy: 'path "secret/*" {' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'unbalanced_braces')).toBe(true)
  })

  it('rejects HCL with no path block', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'app-read', policy: 'foo = "bar"' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_path_block')).toBe(true)
  })

  it('rejects a duplicate policy name (case-folded)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'App-Read', policy: VALID_HCL } },
        { name: 'sec2', fields: { name: 'app-read', policy: VALID_HCL } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('allows two distinct policy names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'app-read', policy: VALID_HCL } },
        { name: 'sec2', fields: { name: 'app-write', policy: VALID_HCL } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractPolicySpecs', () => {
  it('trims and lowercases the name and trims the policy', () => {
    const specs = extractPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'hashicorp-vault',
      entityType: 'policies',
      items: [],
      sections: [{ name: 'sec1', fields: { name: '  App-Read  ', policy: `  ${VALID_HCL}  ` } }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('app-read')
    expect(specs[0].policy).toBe(VALID_HCL)
  })
})

describe('checkPolicyHcl', () => {
  it('accepts a well-formed policy', () => {
    expect(checkPolicyHcl(VALID_HCL).ok).toBe(true)
  })
  it('rejects an empty body', () => {
    const res = checkPolicyHcl('   ')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('empty')
  })
  it('rejects unbalanced braces', () => {
    const res = checkPolicyHcl('path "secret/*" {')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unbalanced_braces')
  })
  it('rejects a closing brace before its opener', () => {
    const res = checkPolicyHcl('} path "secret/*" {')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unbalanced_braces')
  })
  it('rejects a body with no path block', () => {
    const res = checkPolicyHcl('foo { bar = 1 }')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('missing_path_block')
  })
})

describe('normalizePolicy', () => {
  it('treats comment/whitespace-only reformats as equal', () => {
    const a = 'path "secret/*" {\n  capabilities = ["read"] # allow reads\n}'
    const b = 'path "secret/*" {\n\n    capabilities = ["read"]\n\n} // trailing note'
    expect(normalizePolicy(a)).toBe(normalizePolicy(b))
  })
  it('strips # line comments without corrupting a glob path', () => {
    const withComment = 'path "secret/*" {\n  capabilities = ["read"] # only reads\n}'
    const without = 'path "secret/*" { capabilities = ["read"] }'
    expect(normalizePolicy(withComment)).toBe(normalizePolicy(without))
  })
  it('reports drift when the capabilities differ', () => {
    const read = 'path "secret/*" { capabilities = ["read"] }'
    const write = 'path "secret/*" { capabilities = ["read", "update"] }'
    expect(normalizePolicy(read) === normalizePolicy(write)).toBe(false)
  })
})

describe('protected-name helpers', () => {
  it('isRootPolicy folds case and whitespace', () => {
    expect(isRootPolicy(' Root ')).toBe(true)
    expect(isRootPolicy('app-read')).toBe(false)
  })
  it('isDefaultPolicy folds case and whitespace', () => {
    expect(isDefaultPolicy('DEFAULT')).toBe(true)
    expect(isDefaultPolicy('app-read')).toBe(false)
  })
})
