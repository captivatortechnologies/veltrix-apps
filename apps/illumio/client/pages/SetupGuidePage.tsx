import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

// The PCE's built-in label dimensions — always present on every PCE.
const BUILTIN_DIMENSIONS = ['role', 'app', 'env', 'loc']

/**
 * Step-by-step connection guide for the Illumio app, rendered with the
 * platform design-system components from @veltrixsecops/app-sdk/ui — the same
 * Tabs / Card / Badge the built-in platform screens use, themed to the app's
 * brand color. Illumio authenticates with a PCE API key over HTTP Basic auth.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'apikey',
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the PCE, create an <strong>API key</strong> (Settings → API Keys for a service account, or a
              Personal API Key) with the <strong>labels</strong> scope. Note its key (e.g.{' '}
              <code>api_145a5c788e2ba897c</code>) and secret — the secret is shown only once.
            </p>
            <p>This app manages Illumio labels — key/value pairs under these dimensions:</p>
            <div>
              {BUILTIN_DIMENSIONS.map((d) => (
                <Badge key={d} variant="primary" size="sm">
                  {d}
                </Badge>
              ))}
              <Badge variant="secondary" size="sm">
                custom dimension
              </Badge>
            </div>
            <p>
              A custom dimension (beyond the four built-ins) must already exist in the PCE — this app does not
              yet manage label dimensions.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the API key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API key username</strong> → the API key (e.g. <code>api_145a5c788e2ba897c</code>)
              </li>
              <li>
                <strong>API key secret</strong> → the key's secret
              </li>
            </ul>
            <p>
              The app sends these as an HTTP Basic <code>Authorization</code> header on every request — the
              same auth the Illumio Python SDK and Terraform provider use.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'settings',
      label: '3. PCE settings',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Set the app's settings:</p>
            <ul>
              <li>
                <strong>PCE host</strong> → the PCE hostname, no scheme (e.g. <code>pce.example.com</code>)
              </li>
              <li>
                <strong>PCE port</strong> → the HTTPS API port (default <code>8443</code>; some deployments use{' '}
                <code>443</code> — check with your PCE administrator)
              </li>
              <li>
                <strong>Organization ID</strong> → the org this app manages (default <code>1</code> for a
                single-org PCE)
              </li>
              <li>
                <strong>Verify TLS certificate</strong> → off by default (on-premises PCEs commonly ship a
                self-signed or internal-CA certificate); turn on once the PCE presents a certificate this
                platform trusts
              </li>
            </ul>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connect',
      label: '4. Connect',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On the <strong>Connections</strong> page create an <strong>illumio-pce</strong> connection and
              attach the credential. Use <strong>Test</strong> to verify the PCE settings and API key with a
              single authenticated call.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the pipeline.
              Labels are matched by their <strong>(key, value)</strong> pair; IP lists, services and rulesets are
              matched by <strong>name</strong>. IP lists, services and rulesets are drafted then automatically{' '}
              <strong>provisioned</strong> into the active policy in the same deploy — create the labels, IP
              lists and services a ruleset references first, since rulesets resolve those references by name
              and fail closed if any is missing.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
