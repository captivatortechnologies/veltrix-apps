import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  aliasKey,
  extractAliasSpecs,
  isSupportedAliasType,
  URL_TABLE_TYPES,
  validateContentEntry,
  type AliasSpec,
} from './_shared'

// Reserved pf keywords an alias name may not collide with — ported verbatim
// from AliasNameField::getValidators() (github.com/opnsense/core,
// src/opnsense/mvc/app/models/OPNsense/Firewall/FieldTypes/AliasNameField.php),
// itself sourced from pfctl's own parser (sbin/pfctl/parse.y).
const RESERVED_WORDS = new Set([
  'all', 'allow-opts', 'altq', 'anchor', 'antispoof', 'any', 'bandwidth', 'binat', 'binat-anchor', 'bitmask',
  'block', 'block-policy', 'buckets', 'cbq', 'code', 'codelq', 'crop', 'debug', 'divert-reply', 'divert-to',
  'drop', 'drop-ovl', 'dup-to', 'fail-policy', 'fairq', 'fastroute', 'file', 'fingerprints', 'flags',
  'floating', 'flush', 'for', 'fragment', 'from', 'global', 'group', 'hfsc', 'hogs', 'hostid', 'icmp-type',
  'icmp6-type', 'if-bound', 'in', 'include', 'inet', 'inet6', 'interval', 'keep', 'label', 'limit',
  'linkshare', 'load', 'log', 'loginterface', 'max', 'max-mss', 'max-src-conn', 'max-src-conn-rate',
  'max-src-nodes', 'max-src-states', 'min-ttl', 'modulate', 'nat', 'nat-anchor', 'no', 'no-df', 'no-route',
  'no-sync', 'on', 'optimization', 'os', 'out', 'overload', 'pass', 'port', 'prio', 'priority', 'priq',
  'probability', 'proto', 'qlimit', 'queue', 'quick', 'random', 'random-id', 'rdr', 'rdr-anchor', 'realtime',
  'reassemble', 'reply-to', 'require-order', 'return', 'return-icmp', 'return-icmp6', 'return-rst',
  'round-robin', 'route', 'route-to', 'rtable', 'rule', 'ruleset-optimization', 'scrub', 'set', 'set-tos',
  'skip', 'sloppy', 'source-hash', 'source-track', 'state', 'state-defaults', 'state-policy', 'static-port',
  'sticky-address', 'synproxy', 'table', 'tag', 'tagged', 'target', 'tbrsize', 'timeout', 'to', 'tos', 'ttl',
  'upperlimit', 'urpf-failed', 'user',
])

// Same shape as AliasNameField's own validator (github.com/opnsense/core,
// src/opnsense/mvc/app/models/OPNsense/Firewall/FieldTypes/AliasNameField.php):
// starts with a letter or a single underscore, then up to 31 more
// alphanumeric/underscore characters (32 total).
const NAME_RE = /^([a-zA-Z]|(([_a-zA-Z][a-zA-Z0-9]|[a-zA-Z][_a-zA-Z0-9])[_a-zA-Z0-9]{0,29}))$/

function validateName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return 'Name must start with a letter or a single underscore, be 32 characters or fewer, and contain only letters, digits and underscores'
  }
  if (RESERVED_WORDS.has(name)) {
    return `"${name}" is a reserved pf keyword and cannot be used as an alias name`
  }
  return null
}

/**
 * Validate OPNsense firewall-alias configurations: a name that matches
 * OPNsense's own AliasNameField rules and is unique (case-sensitive) across
 * the canvas; a supported `type`; at least one content entry, each format-
 * checked per the declared type; an `interface` when type is
 * "dynipv6host" (Alias.xml's own SetIfConstraint on that field); a
 * non-negative `updatefreq` when set.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: AliasSpec[] = extractAliasSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const nameError = validateName(spec.name)
      if (nameError) {
        errors.push({ field: `${prefix}.name`, message: nameError, code: 'invalid_name' })
      }
      const key = aliasKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate alias "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Type is required', code: 'required' })
    } else if (!isSupportedAliasType(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `"${spec.type}" is not a supported alias type in this app — see README.md for what was scoped out (authgroup, internal, external)`,
        code: 'unsupported_type',
      })
    }

    if (spec.content.length === 0) {
      errors.push({ field: `${prefix}.content`, message: 'At least one content entry is required', code: 'required' })
    } else if (spec.type && isSupportedAliasType(spec.type)) {
      spec.content.forEach((entry, j) => {
        const entryError = validateContentEntry(spec.type, entry)
        if (entryError) {
          errors.push({ field: `${prefix}.content[${j}]`, message: entryError, code: 'invalid_entry' })
        }
      })
    }

    if (spec.type === 'dynipv6host' && !spec.interface) {
      errors.push({
        field: `${prefix}.interface`,
        message: 'Dynamic IPv6 Host aliases require an interface to track',
        code: 'required',
      })
    }

    if (spec.updatefreq != null && spec.updatefreq < 0) {
      errors.push({ field: `${prefix}.updatefreq`, message: 'Update frequency must not be negative', code: 'invalid_value' })
    }
    if (spec.updatefreq != null && spec.type && !URL_TABLE_TYPES.has(spec.type)) {
      warnings.push({
        field: `${prefix}.updatefreq`,
        message: 'Update frequency only applies to URL / URL Table / URL Table (JSON) aliases and is ignored otherwise',
        code: 'ignored_field',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
