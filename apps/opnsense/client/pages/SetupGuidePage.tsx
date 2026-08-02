import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Firewall aliases', 'Firewall categories', 'Firewall rules', 'Source NAT (outbound)']

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
              here. The user needs Effective Privileges covering the Firewall: Aliases, Firewall: Settings and
              Firewall: NAT pages, matching whichever configuration types you use.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'version',
      label: '2. Version check',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              <strong>Firewall Rules</strong> and <strong>Source NAT</strong> require{' '}
              <strong>OPNsense 24.1 &quot;Savvy Shark&quot; (January 2024) or later</strong> — the Firewall
              Automation API they use shipped in core starting with that release (formerly a separate
              &quot;os-firewall&quot; plugin). On an older box every call to those two configuration types
              returns 404. Check your version under <strong>System &gt; Firmware &gt; Status</strong>.
            </p>
            <p>
              <strong>Firewall Aliases</strong> and <strong>Firewall Categories</strong> have no such
              requirement — both have shipped in core for years.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register an <strong>opnsense-firewall</strong> component whose hostname is the same address you
              reach the OPNsense GUI at, and attach the credential. All four configuration types share this one
              component.
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
      label: '4. Stage & apply',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              OPNsense's own model splits every change into two steps: <code>addItem</code>/<code>setItem</code>/
              <code>delItem</code> (aliases, categories) or <code>addRule</code>/<code>setRule</code>/
              <code>delRule</code> (rules, source NAT) only STAGE a create, update or delete into the pending
              configuration. Nothing reaches the running firewall until the matching apply call runs —{' '}
              <code>reconfigure</code> for aliases, <code>apply</code> for rules and source NAT. Categories have
              no apply step at all — they carry no live pf effect.
            </p>
            <p>
              Every deploy or rollback that touches at least one item calls its resource's apply step once, after
              every stage call, so the whole batch takes effect together.
            </p>
            <p>
              <strong>Source NAT only:</strong> manually-declared rules take effect on the wire only when{' '}
              <strong>Firewall &gt; NAT &gt; Outbound</strong> mode is Hybrid or Manual. In the default Automatic
              mode, rules stage and apply successfully but do nothing — this app warns about it in the deploy
              result and in the health check rather than changing the mode for you.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
