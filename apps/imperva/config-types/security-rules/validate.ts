import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  classifyRule,
  readSecurityFields,
  SECURITY_RULE_IDS,
  SECURITY_ACTIONS,
  DDOS_ACTIVATION_MODES,
  DDOS_THRESHOLDS,
  UNKNOWN_CLIENTS_CHALLENGES,
  BOOL_STRINGS,
} from './_shared'

/**
 * Validate WAF security-rule items. Static (no target access): a numeric Site ID,
 * a known Rule ID, and the parameters that Rule ID requires:
 *   - threat rules (SQLi/XSS/RFI/illegal resource/backdoor) → a valid action;
 *   - DDoS → a valid activation mode + threshold (challenge / bot toggles optional);
 *   - bot access control → optional true/false toggles.
 * Each Rule ID is a singleton per site, so a duplicate (siteId, ruleId) is flagged.
 */
const SITE_ID_RE = /^[0-9]+$/
const QUARANTINE_ACTION = 'api.threats.action.quarantine_url'
const BACKDOOR_RULE = 'api.threats.backdoor'

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one security rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = readSecurityFields(item.fields)

    if (!f.siteId) {
      errors.push({ field: `items[${i}].siteId`, message: 'Site ID is required.', code: 'EMPTY_SITE_ID' })
    } else if (!SITE_ID_RE.test(f.siteId)) {
      errors.push({ field: `items[${i}].siteId`, message: `Site ID "${f.siteId}" must be numeric.`, code: 'INVALID_SITE_ID' })
    }

    const kind = classifyRule(f.ruleId)
    if (!f.ruleId) {
      errors.push({ field: `items[${i}].ruleId`, message: 'A rule is required.', code: 'EMPTY_RULE_ID' })
    } else if (!SECURITY_RULE_IDS.has(f.ruleId) || !kind) {
      errors.push({
        field: `items[${i}].ruleId`,
        message: `Rule "${f.ruleId}" is not a supported security rule. Use one of: ${[...SECURITY_RULE_IDS].join(', ')}.`,
        code: 'INVALID_RULE_ID',
      })
    } else if (f.siteId) {
      const key = `${f.siteId}::${f.ruleId}`
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].ruleId`, message: `Rule "${f.ruleId}" is configured more than once for site ${f.siteId}; the last one wins.`, code: 'DUPLICATE_RULE' })
      } else {
        seen.add(key)
      }
    }

    if (kind === 'action') {
      if (!f.securityRuleAction) {
        errors.push({ field: `items[${i}].securityRuleAction`, message: 'An action is required for this rule.', code: 'EMPTY_ACTION' })
      } else if (!SECURITY_ACTIONS.has(f.securityRuleAction)) {
        errors.push({
          field: `items[${i}].securityRuleAction`,
          message: `Action "${f.securityRuleAction}" is not supported. Use one of: ${[...SECURITY_ACTIONS].join(', ')}.`,
          code: 'INVALID_ACTION',
        })
      } else if (f.securityRuleAction === QUARANTINE_ACTION && f.ruleId !== BACKDOOR_RULE) {
        warnings.push({
          field: `items[${i}].securityRuleAction`,
          message: 'Quarantine URL is only valid for Backdoor Protection; Imperva may reject it for this rule.',
          code: 'QUARANTINE_NON_BACKDOOR',
        })
      }
    } else if (kind === 'ddos') {
      if (!f.activationMode) {
        errors.push({ field: `items[${i}].activationMode`, message: 'A DDoS activation mode is required.', code: 'EMPTY_ACTIVATION_MODE' })
      } else if (!DDOS_ACTIVATION_MODES.has(f.activationMode)) {
        errors.push({ field: `items[${i}].activationMode`, message: `Activation mode "${f.activationMode}" is not supported.`, code: 'INVALID_ACTIVATION_MODE' })
      }
      if (!f.ddosTrafficThreshold) {
        errors.push({ field: `items[${i}].ddosTrafficThreshold`, message: 'A DDoS traffic threshold is required.', code: 'EMPTY_THRESHOLD' })
      } else if (!DDOS_THRESHOLDS.has(f.ddosTrafficThreshold)) {
        errors.push({ field: `items[${i}].ddosTrafficThreshold`, message: `Threshold "${f.ddosTrafficThreshold}" is not one of the allowed values (10…5000).`, code: 'INVALID_THRESHOLD' })
      }
      if (f.unknownClientsChallenge && !UNKNOWN_CLIENTS_CHALLENGES.has(f.unknownClientsChallenge)) {
        errors.push({ field: `items[${i}].unknownClientsChallenge`, message: `Unknown-clients challenge "${f.unknownClientsChallenge}" is not supported.`, code: 'INVALID_CHALLENGE' })
      }
      if (f.blockNonEssentialBots && !BOOL_STRINGS.has(f.blockNonEssentialBots)) {
        errors.push({ field: `items[${i}].blockNonEssentialBots`, message: 'Block non-essential bots must be true or false.', code: 'INVALID_BOOL' })
      }
    } else if (kind === 'bot') {
      if (f.blockBadBots && !BOOL_STRINGS.has(f.blockBadBots)) {
        errors.push({ field: `items[${i}].blockBadBots`, message: 'Block bad bots must be true or false.', code: 'INVALID_BOOL' })
      }
      if (f.challengeSuspectedBots && !BOOL_STRINGS.has(f.challengeSuspectedBots)) {
        errors.push({ field: `items[${i}].challengeSuspectedBots`, message: 'Challenge suspected bots must be true or false.', code: 'INVALID_BOOL' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
