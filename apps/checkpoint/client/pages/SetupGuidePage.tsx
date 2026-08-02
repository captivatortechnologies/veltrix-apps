import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Network host objects']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Create an administrator on the Management Server with permission to manage network objects
              (a custom permission profile, or Read/Write All), then choose ONE of:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <ul>
              <li>
                <strong>Username + password</strong> → store the username in the credential
                &quot;Username&quot; field and the password in &quot;Password&quot;
              </li>
              <li>
                <strong>API key</strong> → in SmartConsole, Object Explorer &gt; New &gt; API Key (or{' '}
                <code>mgmt_cli add api-key</code>), then store it in the credential &quot;API token&quot;
                field
              </li>
            </ul>
            <p>An API key, when present, is used instead of username/password.</p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '2. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>checkpoint-management</strong> component whose hostname is the same
              Management Server address you point SmartConsole at, and attach the credential.
            </p>
            <p>
              If the server presents a self-signed certificate (the default for an on-prem Security
              Management Server), leave <strong>Verify TLS certificate</strong> off in the app settings.
              Turn it on once a trusted CA-signed certificate is installed.
            </p>
            <p>
              On a Multi-Domain Security Management server, set the <strong>Domain</strong> setting to the
              Domain Management Server / CMA name to manage. Leave it blank for a standalone server.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'publish',
      label: '3. Sessions & publishing',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Every deploy opens its own Management API session: it logs in, applies every declared
              change, then calls <code>publish</code> to commit them together. If anything fails partway,
              the whole session is <code>discard</code>ed instead — a failed deploy never leaves a
              half-applied change published.
            </p>
            <p>
              Publishing here does <strong>not</strong> install a security policy on any gateway — it only
              commits the object changes to the management database, exactly like clicking Publish in
              SmartConsole.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
