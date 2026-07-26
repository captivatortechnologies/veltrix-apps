import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

// Address kinds this configuration type manages.
const ADDRESS_TYPES = ['ipmask (IP / subnet)', 'iprange', 'fqdn', 'geography']

/**
 * Step-by-step connection guide for the FortiManager app, rendered with the
 * platform design-system components from @veltrixsecops/app-sdk/ui — the same
 * Tabs / Card / Badge the built-in platform screens use, themed to the app's
 * brand color. FortiManager authenticates with an admin user over JSON-RPC.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'user',
      label: '1. API user',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In FortiManager, create (or reuse) an <strong>administrator</strong> with read/write
              access to the ADOM object database. A dedicated JSON-RPC user is recommended. Note its
              username and password.
            </p>
            <p>
              This app manages firewall <strong>address</strong> objects of these kinds:
            </p>
            <div>
              {ADDRESS_TYPES.map((t) => (
                <Badge key={t} variant="primary" size="sm">
                  {t}
                </Badge>
              ))}
            </div>
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
            <p>Store the administrator as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the FortiManager admin username
              </li>
              <li>
                <strong>Password</strong> → that admin's password
              </li>
            </ul>
            <p>
              The app logs in over JSON-RPC (<code>exec sys/login/user</code>) and reuses the session
              token for the rest of the deploy.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'settings',
      label: '3. Host & ADOM',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Set the app's settings:</p>
            <ul>
              <li>
                <strong>Host</strong> → the FortiManager hostname or URL (e.g.{' '}
                <code>fmg.example.com</code>). It must present a certificate the platform trusts.
              </li>
              <li>
                <strong>ADOM</strong> → the Administrative Domain to manage (default{' '}
                <code>root</code>).
              </li>
              <li>
                <strong>Workspace mode</strong> → enable if your ADOM uses workspace/workflow mode;
                the app then wraps deploys in a lock / commit / unlock transaction.
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
              On the <strong>Connections</strong> page create a <strong>fortimanager</strong>{' '}
              connection and attach the credential. Use <strong>Test</strong> to verify the login and
              ADOM access.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Addresses are matched by <strong>name</strong> (the FortiManager mkey) and
              upserted with <code>set</code>; reconcile only deletes addresses this app created.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
