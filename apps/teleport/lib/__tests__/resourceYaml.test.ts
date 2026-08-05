import { buildResourceYaml, normalizeResourceYaml, parseResourceHeader, hasNonEmptySpec } from '../resourceYaml'

describe('buildResourceYaml', () => {
  it('wraps a spec body in a full kind/version/metadata/spec envelope', () => {
    const yaml = buildResourceYaml('role', 'v7', 'my-role', 'allow:\n  logins: [root]')
    expect(yaml).toBe('kind: role\nversion: v7\nmetadata:\n  name: my-role\nspec:\n  allow:\n    logins: [root]\n')
  })

  it('drops trailing whitespace-only lines from the indented spec', () => {
    const yaml = buildResourceYaml('role', 'v7', 'x', 'allow:\n  logins: [root]\n\n   \n')
    expect(yaml.endsWith('spec:\n  allow:\n    logins: [root]\n')).toBeTruthy()
  })
})

describe('normalizeResourceYaml', () => {
  it('treats a reformatted document as equal', () => {
    const a = 'kind: role\nversion: v7\nmetadata:\n  name: x\nspec:\n  allow:\n    logins: [root]\n'
    const b = 'kind: role\nversion: v7\n\nmetadata:\n   name:   x\nspec:\n  allow:\n    logins: [root]  \n'
    expect(normalizeResourceYaml(a)).toBe(normalizeResourceYaml(b))
  })

  it('strips line comments', () => {
    const withComment = 'kind: role # a comment\nspec:\n  allow: {}'
    const without = 'kind: role\nspec:\n  allow: {}'
    expect(normalizeResourceYaml(withComment)).toBe(normalizeResourceYaml(without))
  })

  it('detects a real content change', () => {
    const a = 'kind: role\nspec:\n  allow:\n    logins: [root]'
    const b = 'kind: role\nspec:\n  allow:\n    logins: [ubuntu]'
    expect(normalizeResourceYaml(a) === normalizeResourceYaml(b)).toBeFalsy()
  })
})

describe('parseResourceHeader', () => {
  it('extracts kind and metadata.name from a full document', () => {
    const yaml = buildResourceYaml('github', 'v3', 'github-sso', 'client_id: abc\nclient_secret: shh')
    const header = parseResourceHeader(yaml)
    expect(header.kind).toBe('github')
    expect(header.name).toBe('github-sso')
  })

  it('handles quoted values', () => {
    const yaml = 'kind: "trusted_cluster"\nmetadata:\n  name: \'leaf-1\'\nspec: {}'
    const header = parseResourceHeader(yaml)
    expect(header.kind).toBe('trusted_cluster')
    expect(header.name).toBe('leaf-1')
  })

  it('returns nulls when kind/name are absent', () => {
    const header = parseResourceHeader('spec:\n  allow: {}')
    expect(header.kind).toBeNull()
    expect(header.name).toBeNull()
  })

  it('does not pick up a name field outside metadata', () => {
    const yaml = 'kind: role\nmetadata:\n  name: real-name\nspec:\n  name: not-the-identity\n'
    const header = parseResourceHeader(yaml)
    expect(header.name).toBe('real-name')
  })
})

describe('hasNonEmptySpec', () => {
  it('is false for blank or comment-only content', () => {
    expect(hasNonEmptySpec('')).toBeFalsy()
    expect(hasNonEmptySpec('   \n  \n')).toBeFalsy()
    expect(hasNonEmptySpec('# just a comment\n')).toBeFalsy()
  })

  it('is true once real content is present', () => {
    expect(hasNonEmptySpec('allow:\n  logins: [root]')).toBeTruthy()
  })
})
