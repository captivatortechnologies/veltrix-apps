// =============================================================================
// Defender Attack Surface Reduction (ASR) rules — settings-catalog domain model.
//
// ASR rule policies are Intune endpoint-security settings-catalog policies
// (templateFamily=endpointSecurityAttackSurfaceReduction). The body is a single
// GroupSettingCollection whose children are per-rule choice settings, plus an
// optional path-exclusions SimpleSettingCollection.
//
// Every id / template GUID below is verified against Microsoft Learn AND real
// exported policy bodies (OpenIntuneBaseline, CIPP-Templates) AND the live Graph
// setting/template definitions — not derived or guessed. See the ASR reference:
// https://learn.microsoft.com/en-us/defender-endpoint/attack-surface-reduction-rules-reference
// =============================================================================

export const ASR_TEMPLATE_ID = 'e8c053d6-9f95-42b1-a7f1-ebfd71c67a4b_1'
export const ASR_TEMPLATE_FAMILY = 'endpointSecurityAttackSurfaceReduction'

const RULE_PREFIX = 'device_vendor_msft_policy_config_defender_attacksurfacereductionrules'
export const ASR_GROUP_SETTING_ID = RULE_PREFIX
export const ASR_GROUP_TEMPLATE_ID = '19600663-e264-4c02-8f55-f2983216d6d7'
export const ASR_EXCLUSIONS_SETTING_ID = 'device_vendor_msft_policy_config_defender_attacksurfacereductiononlyexclusions'
export const ASR_EXCLUSIONS_TEMPLATE_ID = '0eaea6bb-736e-44ed-a450-b2ef5bea1377'

/** Valid rule states. "notconfigured" means: omit the rule from the policy body. */
export const ASR_STATES = ['notconfigured', 'off', 'block', 'audit', 'warn'] as const
export type AsrState = (typeof ASR_STATES)[number]

/** One ASR rule: its canvas field key, human label, and settings-catalog id suffix. */
export interface AsrRule {
  key: string
  label: string
  suffix: string
}

/** The 19 ASR rules (settings-catalog child order). suffix appends to RULE_PREFIX + '_'. */
export const ASR_RULES: AsrRule[] = [
  { key: 'block_email_executable', label: 'Block executable content from email client and webmail', suffix: 'blockexecutablecontentfromemailclientandwebmail' },
  { key: 'block_office_child_process', label: 'Block all Office applications from creating child processes', suffix: 'blockallofficeapplicationsfromcreatingchildprocesses' },
  { key: 'block_office_executable_content', label: 'Block Office applications from creating executable content', suffix: 'blockofficeapplicationsfromcreatingexecutablecontent' },
  { key: 'block_office_code_injection', label: 'Block Office applications from injecting code into other processes', suffix: 'blockofficeapplicationsfrominjectingcodeintootherprocesses' },
  { key: 'block_js_vbs_download', label: 'Block JavaScript or VBScript from launching downloaded executable content', suffix: 'blockjavascriptorvbscriptfromlaunchingdownloadedexecutablecontent' },
  { key: 'block_obfuscated_scripts', label: 'Block execution of potentially obfuscated scripts', suffix: 'blockexecutionofpotentiallyobfuscatedscripts' },
  { key: 'block_office_macro_win32', label: 'Block Win32 API calls from Office macros', suffix: 'blockwin32apicallsfromofficemacros' },
  { key: 'block_untrusted_executables', label: 'Block executable files unless they meet a prevalence/age/trusted-list criterion', suffix: 'blockexecutablefilesrunningunlesstheymeetprevalenceagetrustedlistcriterion' },
  { key: 'ransomware_protection', label: 'Use advanced protection against ransomware', suffix: 'useadvancedprotectionagainstransomware' },
  { key: 'block_lsass_credential_theft', label: 'Block credential stealing from the Windows LSASS subsystem', suffix: 'blockcredentialstealingfromwindowslocalsecurityauthoritysubsystem' },
  { key: 'block_psexec_wmi', label: 'Block process creations from PSExec and WMI commands', suffix: 'blockprocesscreationsfrompsexecandwmicommands' },
  { key: 'block_usb_untrusted', label: 'Block untrusted and unsigned processes that run from USB', suffix: 'blockuntrustedunsignedprocessesthatrunfromusb' },
  { key: 'block_office_comm_child_process', label: 'Block Office communication apps from creating child processes', suffix: 'blockofficecommunicationappfromcreatingchildprocesses' },
  { key: 'block_adobe_child_process', label: 'Block Adobe Reader from creating child processes', suffix: 'blockadobereaderfromcreatingchildprocesses' },
  { key: 'block_wmi_persistence', label: 'Block persistence through WMI event subscription', suffix: 'blockpersistencethroughwmieventsubscription' },
  { key: 'block_vulnerable_drivers', label: 'Block abuse of exploited vulnerable signed drivers', suffix: 'blockabuseofexploitedvulnerablesigneddrivers' },
  { key: 'block_webshell_servers', label: 'Block Webshell creation for servers (Exchange only)', suffix: 'blockwebshellcreationforservers' },
  { key: 'block_safemode_reboot', label: 'Block rebooting machine in Safe Mode', suffix: 'blockrebootingmachineinsafemode' },
  { key: 'block_impersonated_system_tools', label: 'Block use of copied or impersonated system tools', suffix: 'blockuseofcopiedorimpersonatedsystemtools' },
]

const RULE_BY_KEY = new Map(ASR_RULES.map((r) => [r.key, r]))
const RULE_BY_DEFID = new Map(ASR_RULES.map((r) => [`${RULE_PREFIX}_${r.suffix}`, r]))

export function ruleSettingId(rule: AsrRule): string {
  return `${RULE_PREFIX}_${rule.suffix}`
}

export interface AsrPolicySpec {
  sectionName: string
  name: string
  description: string
  /** key → state; only 'off'/'block'/'audit'/'warn' are emitted, 'notconfigured' is skipped. */
  rules: Record<string, AsrState>
  exclusions: string[]
}

export function normalizeState(value: unknown): AsrState {
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if ((ASR_STATES as readonly string[]).includes(t)) return t as AsrState
  }
  return 'notconfigured'
}

/** Count the rules that are actually configured (not "notconfigured"). */
export function configuredRuleCount(spec: AsrPolicySpec): number {
  return ASR_RULES.reduce((n, r) => n + (spec.rules[r.key] && spec.rules[r.key] !== 'notconfigured' ? 1 : 0), 0)
}

// --- Body builder ------------------------------------------------------------

function choiceChild(rule: AsrRule, state: AsrState): Record<string, unknown> {
  const defId = ruleSettingId(rule)
  return {
    '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingInstance',
    settingDefinitionId: defId,
    settingInstanceTemplateReference: null,
    choiceSettingValue: {
      '@odata.type': '#microsoft.graph.deviceManagementConfigurationChoiceSettingValue',
      settingValueTemplateReference: null,
      value: `${defId}_${state}`,
      children: [],
    },
  }
}

/** Build the full POST/PATCH body for an ASR policy. */
export function buildAsrPolicyBody(spec: AsrPolicySpec): Record<string, unknown> {
  const children = ASR_RULES.filter((r) => {
    const s = spec.rules[r.key]
    return s && s !== 'notconfigured'
  }).map((r) => choiceChild(r, spec.rules[r.key]))

  const settings: Array<Record<string, unknown>> = []

  if (children.length > 0) {
    settings.push({
      '@odata.type': '#microsoft.graph.deviceManagementConfigurationSetting',
      settingInstance: {
        '@odata.type': '#microsoft.graph.deviceManagementConfigurationGroupSettingCollectionInstance',
        settingDefinitionId: ASR_GROUP_SETTING_ID,
        settingInstanceTemplateReference: {
          '@odata.type': '#microsoft.graph.deviceManagementConfigurationSettingInstanceTemplateReference',
          settingInstanceTemplateId: ASR_GROUP_TEMPLATE_ID,
        },
        groupSettingCollectionValue: [
          {
            '@odata.type': '#microsoft.graph.deviceManagementConfigurationGroupSettingValue',
            settingValueTemplateReference: null,
            children,
          },
        ],
      },
    })
  }

  if (spec.exclusions.length > 0) {
    settings.push({
      '@odata.type': '#microsoft.graph.deviceManagementConfigurationSetting',
      settingInstance: {
        '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingCollectionInstance',
        settingDefinitionId: ASR_EXCLUSIONS_SETTING_ID,
        settingInstanceTemplateReference: {
          '@odata.type': '#microsoft.graph.deviceManagementConfigurationSettingInstanceTemplateReference',
          settingInstanceTemplateId: ASR_EXCLUSIONS_TEMPLATE_ID,
        },
        simpleSettingCollectionValue: spec.exclusions.map((path) => ({
          '@odata.type': '#microsoft.graph.deviceManagementConfigurationSimpleSettingValue',
          settingValueTemplateReference: null,
          value: path,
        })),
      },
    })
  }

  return {
    name: spec.name,
    description: spec.description,
    platforms: 'windows10',
    technologies: 'mdm,microsoftSense',
    roleScopeTagIds: ['0'],
    templateReference: {
      '@odata.type': '#microsoft.graph.deviceManagementConfigurationPolicyTemplateReference',
      templateId: ASR_TEMPLATE_ID,
      templateFamily: ASR_TEMPLATE_FAMILY,
    },
    settings,
  }
}

// --- Live-policy parsing (drift / health) ------------------------------------

/** A configurationPolicy as returned by GET (list or $expand=settings). */
export interface LivePolicy {
  id?: string
  name?: string
  description?: string
  templateReference?: { templateFamily?: string; templateId?: string }
  settings?: unknown
}

/** True when a live policy is an ASR-rules endpoint-security policy. */
export function isAsrPolicy(policy: LivePolicy): boolean {
  return policy.templateReference?.templateFamily === ASR_TEMPLATE_FAMILY
}

/** Extract the configured rule states from a live policy's expanded settings. */
export function parseLiveRuleStates(policy: LivePolicy): Record<string, AsrState> {
  const states: Record<string, AsrState> = {}
  const settings = Array.isArray(policy.settings) ? (policy.settings as Array<Record<string, unknown>>) : []
  for (const setting of settings) {
    const instance = setting?.settingInstance as Record<string, unknown> | undefined
    if (!instance || instance.settingDefinitionId !== ASR_GROUP_SETTING_ID) continue
    const groupValues = instance.groupSettingCollectionValue as Array<Record<string, unknown>> | undefined
    const childList = (groupValues?.[0]?.children as Array<Record<string, unknown>> | undefined) ?? []
    for (const child of childList) {
      const defId = typeof child.settingDefinitionId === 'string' ? child.settingDefinitionId : ''
      const rule = RULE_BY_DEFID.get(defId)
      if (!rule) continue
      const choiceValue = child.choiceSettingValue as Record<string, unknown> | undefined
      const value = typeof choiceValue?.value === 'string' ? choiceValue.value : ''
      const suffix = value.startsWith(`${defId}_`) ? value.slice(defId.length + 1) : ''
      states[rule.key] = normalizeState(suffix)
    }
  }
  return states
}

export { RULE_BY_KEY }
