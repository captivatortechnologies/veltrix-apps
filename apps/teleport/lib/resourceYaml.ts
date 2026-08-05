// =============================================================================
// Minimal, dependency-free helpers for Teleport's "dynamic resource" YAML
// envelope — the same `kind` / `version` / `metadata.name` / `spec` shape
// `tctl create -f role.yaml` accepts, and what the Proxy web API's
// `ResourceItem.content` field carries verbatim (see
// lib/web/ui/resource.go's `NewResourceItem`, which does `yaml.Marshal(resource)`
// and lib/web/resources.go's `ExtractResourceAndValidate` / `extractResource`,
// which decodes the posted `content` string with a generic YAML-or-JSON
// resource decoder — gravitational/teleport@master).
//
// No YAML library is bundled — the platform only guarantees the SDK at
// runtime (apps/velociraptor/lib/velociraptorApi.ts documents the same
// no-external-deps constraint for its own hand-rolled config-bundle parser).
// Three config types (roles, github-connectors, trusted-clusters) let the user
// author only the `spec:` body, in a textarea, exactly like
// apps/hashicorp-vault/config-types/policies lets the user author only the
// HCL policy body — this module builds the full envelope around it and
// normalizes both sides for drift comparison.
// =============================================================================

/** Build a complete Teleport resource YAML document from its parts. */
export function buildResourceYaml(kind: string, version: string, name: string, specYaml: string): string {
  const indentedSpec = specYaml
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `  ${line}` : ''))
    .join('\n')
    .replace(/\s+$/, '')

  return `kind: ${kind}\nversion: ${version}\nmetadata:\n  name: ${name}\nspec:\n${indentedSpec}\n`
}

/**
 * Canonicalize a full resource YAML document for drift comparison: strip `#`
 * line comments and collapse whitespace. Teleport re-serializes whatever it
 * stores (field order, quoting, blank lines can all shift), so a cosmetic
 * reformat must not read as drift — only a meaningful field change should.
 * Mirrors apps/hashicorp-vault/config-types/policies/validate.ts's
 * `normalizePolicy`.
 */
export function normalizeResourceYaml(yamlText: string): string {
  return yamlText
    .replace(/#.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ParsedResourceHeader {
  kind: string | null
  name: string | null
}

/**
 * Line-oriented (NOT a YAML parser) extraction of `kind` and `metadata.name`
 * from a resource YAML document, for light structural validation. There is no
 * server-side dry-run for these resources — the real gate is Teleport's own
 * decode + validation on write (the same reasoning
 * apps/hashicorp-vault/config-types/policies/validate.ts documents for its
 * "not an HCL parser" HCL sanity check).
 */
export function parseResourceHeader(yamlText: string): ParsedResourceHeader {
  const lines = yamlText.split(/\r?\n/)
  let kind: string | null = null
  let name: string | null = null
  let inMetadata = false
  let metadataIndent = -1

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '')
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length

    if (indent === 0) {
      const kindMatch = /^kind:\s*(.+)$/.exec(line.trim())
      if (kindMatch) kind = stripYamlQuotes(kindMatch[1])
      inMetadata = /^metadata:\s*$/.test(line.trim())
      metadataIndent = inMetadata ? indent : -1
      continue
    }

    if (inMetadata) {
      if (indent <= metadataIndent) {
        inMetadata = false
        continue
      }
      const nameMatch = /^name:\s*(.+)$/.exec(line.trim())
      if (nameMatch && !name) name = stripYamlQuotes(nameMatch[1])
    }
  }

  return { kind, name }
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** True when `spec` has at least one non-blank, non-comment line (a bare-minimum sanity check). */
export function hasNonEmptySpec(specYaml: string): boolean {
  return specYaml
    .split(/\r?\n/)
    .some((line) => line.replace(/#.*$/, '').trim().length > 0)
}
