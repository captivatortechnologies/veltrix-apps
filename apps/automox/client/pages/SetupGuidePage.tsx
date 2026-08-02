import React from 'react'
import { Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card the built-in
 * platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'apikey',
      label: '1. API key & Org ID',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Automox Console, go to <strong>Settings &gt; API Keys</strong> and generate a new
              key. Copy the value — Automox shows it once.
            </p>
            <p>
              Find your numeric <strong>Organization ID</strong> in the console URL
              (<code>console.automox.com/console/organization/&lt;id&gt;/...</code>) or by calling{' '}
              <code>GET /orgs</code> with the new key. Almost every Automox endpoint this app uses
              requires the Organization ID as the <code>o</code> query parameter, so both values are
              needed.
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
            <p>Store both values as a Veltrix credential on the Connections page:</p>
            <ul>
              <li>
                <strong>Organization ID</strong> → your numeric Automox Organization ID
              </li>
              <li>
                <strong>API key</strong> → the Automox API key
              </li>
            </ul>
            <p>
              The app authenticates every request with <code>Authorization: Bearer &lt;key&gt;</code>{' '}
              against the fixed endpoint <code>https://console.automox.com/api</code>, appending{' '}
              <code>?o=&lt;organization id&gt;</code> automatically.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'author',
      label: '3. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Saving a connection registers an <strong>automox-org</strong> deploy target automatically.
              Then author a <strong>Policies</strong> configuration in the Configuration Canvas and
              deploy it through the pipeline. A policy's <strong>name</strong> is its identity —
              renaming a policy in the canvas updates the same Automox policy in place rather than
              creating a duplicate.
            </p>
            <p>
              <strong>Patch</strong> policies are modeled in full (schedule, patch rule, filters,
              notifications, device targeting). <strong>Required Software</strong> and{' '}
              <strong>Custom (Worklet)</strong> policies take a raw Configuration (JSON) object — their
              full schemas are not yet modeled by this app; author the type-specific fields (e.g.{' '}
              <code>package_name</code> / <code>installation_code</code> for Required Software) directly
              as JSON in the policy item.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
