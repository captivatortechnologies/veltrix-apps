import type { Provider } from '../../lib/model/types'
import { AWS_ACCOUNT_TYPE, AZURE_SUBSCRIPTION_TYPE } from './status'

/** The cloud a target component belongs to, from its platform component type. */
export function componentProvider(component: { type?: string[] | null }): Provider | null {
  const types = component.type ?? []
  if (types.includes(AWS_ACCOUNT_TYPE)) return 'aws'
  if (types.includes(AZURE_SUBSCRIPTION_TYPE)) return 'azure'
  return null
}

/** A policy applies to a component only when both are the same cloud. */
export function policyTargetsComponent(model: { provider?: unknown }, component: { type?: string[] | null }): boolean {
  const provider = componentProvider(component)
  return provider !== null && model.provider === provider
}
