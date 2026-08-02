import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Firewall aliases']

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
              Generate an API key/secret pair for an OPNsense user: <strong>System &gt; Access &gt; Users</strong>{' '}
              &gt; open the user &gt; <strong>API keys</strong> &gt; <strong>+</strong>. OPNsense downloads a{' '}
              <code>.txt</code> file with the pair once — it cannot be retrieved again, only regenerated.
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the <strong>key</strong> in the credential &quot;Username&quot; field and the{' '}
              <strong>secret</strong> in &quot;Password&quot; (or &quot;API token&quot;) — both work the same way
              here. The user needs Effective Privileges covering the Firewall: Alias page.
            </p>
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
              Register an <strong>opnsense-firewall</strong> component whose hostname is the same address you
              reach the OPNsense GUI at, and attach the credential.
            </p>
            <p>
              OPNsense ships a self-signed certificate on its GUI/API by default — leave{' '}
              <strong>Verify TLS certificate</strong> off in the app settings until a CA-signed certificate is
              installed.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'apply',
      label: '3. Stage & apply',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              OPNsense's own model splits every change into two steps: <code>addItem</code>/<code>setItem</code>/
              <code>delItem</code> only STAGE a create, update or delete into the pending configuration.
              Nothing reaches the running firewall until <code>reconfigure</code> runs — that call reloads the
              pf filter and alias tables.
            </p>
            <p>
              Every deploy or rollback that touches at least one alias calls <code>reconfigure</code> once, after
              every stage call, so the whole batch takes effect together.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
