// The provisioning key SECRET, and the leak check for it.
//
// `leaksSecret` in the shared fake covers the OneAPI access token and client
// secret. A provisioning key is a THIRD secret, specific to this configuration
// type: ZPA generates it on create, returns it in the create response AND on
// every subsequent listing, and anyone holding it can enroll a connector into
// the customer's tenant. It must therefore never reach a result message, an
// artifact, rollbackData, a drift diff or a request body.
//
// This lives here rather than in the shared harness because only this config
// type has such a value; it is not a test file, so the runner ignores it.

/** The key value ZPA hands back. Distinctive on purpose. */
export const PROVISIONING_KEY = '3|api.private.zscaler.com|PROVISIONING-KEY-MUST-NOT-LEAK'

/** True when the provisioning key value appears anywhere in `value`. */
export function leaksProvisioningKey(value: unknown): boolean {
  const json = JSON.stringify(value ?? null) ?? ''
  return json.includes(PROVISIONING_KEY)
}
