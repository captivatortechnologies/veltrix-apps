import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'tenable-vm',
  pages: {
    OverviewPage,
    SetupGuidePage,
    ConnectionsPage,
  },
  sidebarItems: [
    { path: '/apps/tenable-vm/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/tenable-vm/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/tenable-vm/connections', label: 'Connections', icon: 'link' },
  ],
}
