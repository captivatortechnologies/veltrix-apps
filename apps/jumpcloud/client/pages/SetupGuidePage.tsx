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
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the JumpCloud Admin Portal, click your account name and select <strong>My API Key</strong>,
              then generate a key if you have not already. The key inherits the permissions of the admin
              who owns it, so use an admin scoped to what this app manages (User Groups).
            </p>
            <p>Copy the key value — JumpCloud shows it once.</p>
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
            <p>Store the key as a Veltrix credential on the Connections page:</p>
            <ul>
              <li>
                <strong>API key</strong> → the JumpCloud API key
              </li>
              <li>
                <strong>Org ID</strong> (optional) → only for multi-tenant (MTP) admins managing several
                organizations; sent as the <code>x-org-id</code> header. Single-tenant admins leave it blank.
              </li>
            </ul>
            <p>
              The app authenticates every request with <code>x-api-key: &lt;key&gt;</code> against the fixed
              endpoint <code>https://console.jumpcloud.com/api</code>.
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
              Saving a connection registers a <strong>jumpcloud-org</strong> deploy target automatically.
              Then author a <strong>User Groups</strong> configuration in the Configuration Canvas and deploy
              it through the pipeline. A group's <strong>name</strong> is its identity — renaming a group in
              the canvas updates the same JumpCloud group in place rather than creating a duplicate.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
