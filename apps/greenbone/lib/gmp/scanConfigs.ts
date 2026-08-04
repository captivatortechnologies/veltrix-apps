// =============================================================================
// GMP entity — Scan Configs (<create_config>/<get_configs>/<modify_config>/
// <delete_config>). A scan config is the NVT/family selection + scanner
// preference set a scan task runs. Built on the transport + wire-format
// primitives in ../greenboneApi.ts.
//
// Verified against the GMP 22.5 command reference (cite):
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_create_config
//   https://docs.greenbone.net/API/GMP/gmp-22.5.html#command_modify_config
// and python-gvm's request builders (gvm/protocols/gmp/requests/v224/_scan_configs.py),
// which GMP 22.5 (v225) inherits unchanged.
//
// FLAGS — verify against a live gvmd (GMP is version-specific):
//   * CREATE IS CLONE-ONLY: create_config's schema is `comment? & (copy |
//     get_configs_response | scanner) & name & usage_type?` — there is NO way
//     to define NVT/family selections from scratch on create. This app always
//     clones an existing base config (default: the well-known feed config
//     "Full and fast", daba56c8-73ec-11df-a475-002264764cea — same well-known
//     UUID convention as the PORT_LIST_* constants in ../greenboneApi.ts) and
//     then applies the declared family/nvt selection + preferences via
//     modify_config.
//   * MODIFY IS MULTI-ACTION: since GMP 21.04, one modify_config call can carry
//     name/comment/family_selection/nvt_selection*/preference* together; gvmd
//     applies them in document order (the doc warns overlapping actions are
//     order-sensitive) — this builder always emits them in the same order
//     (name, comment, family_selection, nvt_selection, preference) so re-deploys
//     are deterministic.
//   * preference/value is base64 (see encodeGmpValue in ../greenboneApi.ts).
//   * DRIFT IS NAME/COMMENT ONLY: the live get_configs response represents
//     family/nvt selection and preferences in a much richer nested shape than
//     the compact JSON this app declares them in (and reading it back requires
//     `details=1`, which this app does not request). Comparing them reliably
//     would require reverse-engineering that shape against a live gvmd, which
//     is out of scope here — drift only compares name/comment; every deploy
//     unconditionally RE-APPLIES the declared family/nvt/preferences JSON, so
//     the config never silently drifts out of the desired selection even
//     though drift-detection can't independently confirm it. Documented in the
//     app README's Coverage/limitations section.
// =============================================================================

import { attrsFrom, firstChildText, encodeGmpValue, escapeXmlAttr, escapeXmlText } from '../greenboneApi'

/** The feed-provided "Full and fast" scan config — the common clone base. Well-known, stable across installs that load the Greenbone feed. */
export const SCAN_CONFIG_FULL_AND_FAST = 'daba56c8-73ec-11df-a475-002264764cea'

export function buildGetConfigsCommand(opts: { filter?: string } = {}): string {
  const filter = opts.filter ?? 'rows=-1'
  return `<get_configs usage_type="scan" filter="${escapeXmlAttr(filter)}"/>`
}

export interface FamilySelectionEntry {
  name: string
  all?: boolean
  growing?: boolean
}

export interface FamilySelectionInput {
  /** <family_selection><growing>…</growing> — whether newly-fed families are auto-included. */
  growing?: boolean
  families: FamilySelectionEntry[]
}

export interface NvtSelectionEntry {
  family: string
  oids: string[]
}

export interface PreferenceInput {
  name: string
  /** Present only for an NVT-scoped preference. */
  nvtOid?: string
  value: string
}

export interface ScanConfigModifyInput {
  name?: string
  comment?: string
  familySelection?: FamilySelectionInput
  nvtSelections?: NvtSelectionEntry[]
  preferences?: PreferenceInput[]
}

export function buildCreateConfigCommand(baseConfigId: string, name: string): string {
  return `<create_config><copy>${escapeXmlText(baseConfigId)}</copy><name>${escapeXmlText(name)}</name></create_config>`
}

/** One modify_config call carrying every declared action, in a fixed, deterministic order (see FLAGS). */
export function buildModifyConfigCommand(configId: string, input: ScanConfigModifyInput): string {
  const parts: string[] = []
  if (input.name !== undefined) parts.push(`<name>${escapeXmlText(input.name)}</name>`)
  if (input.comment !== undefined) parts.push(`<comment>${escapeXmlText(input.comment)}</comment>`)

  if (input.familySelection) {
    const fam = input.familySelection.families
      .map(
        (f) =>
          `<family><name>${escapeXmlText(f.name)}</name><all>${f.all ? 1 : 0}</all><growing>${f.growing ? 1 : 0}</growing></family>`,
      )
      .join('')
    parts.push(`<family_selection><growing>${input.familySelection.growing ? 1 : 0}</growing>${fam}</family_selection>`)
  }

  for (const sel of input.nvtSelections ?? []) {
    const nvts = sel.oids.map((oid) => `<nvt oid="${escapeXmlAttr(oid)}"/>`).join('')
    parts.push(`<nvt_selection><family>${escapeXmlText(sel.family)}</family>${nvts}</nvt_selection>`)
  }

  for (const pref of input.preferences ?? []) {
    const nvt = pref.nvtOid ? `<nvt oid="${escapeXmlAttr(pref.nvtOid)}"/>` : ''
    parts.push(`<preference><name>${escapeXmlText(pref.name)}</name>${nvt}<value>${encodeGmpValue(pref.value)}</value></preference>`)
  }

  return `<modify_config config_id="${escapeXmlAttr(configId)}">${parts.join('')}</modify_config>`
}

export function buildDeleteConfigCommand(configId: string, ultimate = true): string {
  return `<delete_config config_id="${escapeXmlAttr(configId)}" ultimate="${ultimate ? '1' : '0'}"/>`
}

export interface GmpScanConfig {
  id: string
  name: string
  comment: string
}

/** Parse `<config id="…">…</config>` elements out of a get_configs_response (name/comment only — see FLAGS). */
export function parseConfigs(xml: string): GmpScanConfig[] {
  const out: GmpScanConfig[] = []
  const re = /<config\b([^>]*)>([\s\S]*?)<\/config>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const id = attrsFrom(m[1]).id
    if (!id) continue
    const body = m[2]
    out.push({ id, name: firstChildText(body, 'name') ?? '', comment: firstChildText(body, 'comment') ?? '' })
  }
  return out
}
