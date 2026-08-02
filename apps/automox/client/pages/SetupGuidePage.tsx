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
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. An item's <strong>name</strong> is its identity — renaming it in the canvas
              updates the same Automox object in place rather than creating a duplicate.
            </p>
            <ul>
              <li>
                <strong>Policies</strong> — patch policies (schedule, patch rule, filters,
                notifications, device targeting).
              </li>
              <li>
                <strong>Worklets</strong> — Custom (Worklet) policies (evaluation/remediation scripts)
                and Required Software policies (package name/version/installer). Reconciled
                independently from Policies, so a Worklet can share a name with a patch Policy without
                either overwriting the other.
              </li>
              <li>
                <strong>Server Groups</strong> — device groups, patch scan cadence, and WSUS / OS
                update enforcement.
              </li>
            </ul>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
