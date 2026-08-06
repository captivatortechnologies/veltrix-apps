import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'bitdefender-gravityzone',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/bitdefender-gravityzone/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/bitdefender-gravityzone/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/bitdefender-gravityzone/connections', label: 'Connections', icon: 'link' },
  ],
}
