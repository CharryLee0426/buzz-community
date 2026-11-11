import { Suspense } from 'react'
import { Outlet, useLocation } from 'react-router'
import { AppShell } from '@astryxdesign/core/AppShell'
import { Icon } from '@astryxdesign/core/Icon'
import { NavIcon } from '@astryxdesign/core/NavIcon'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { useToast } from '@astryxdesign/core/Toast'
import { ArrowRightStartOnRectangleIcon } from '@heroicons/react/24/outline'
import { BrandMark } from '../components/BrandMark'
import { PageSpinner } from '../components/PageSpinner'
import { RouteErrorBoundary } from '../components/RouteErrorBoundary'
import { useSignOut, type SessionInfo } from '../lib/session'
import { isActive, NAV_GROUPS, SETTINGS_ENTRY, type NavEntry } from './navigation'

function NavLinkItem({ entry, pathname }: { entry: NavEntry; pathname: string }) {
  return (
    <SideNavItem
      label={entry.label}
      href={entry.path}
      icon={entry.icon}
      selectedIcon={entry.selectedIcon}
      isSelected={isActive(entry.path, pathname)}
    />
  )
}

export function Shell({ session }: { session: SessionInfo }) {
  const { pathname } = useLocation()
  const signOut = useSignOut()
  const showToast = useToast()

  return (
    <AppShell
      contentPadding={0}
      sideNav={
        <SideNav
          collapsible
          resizable={{ defaultWidth: 248, minWidth: 208, maxWidth: 320, autoSaveId: 'buzz-admin-side-nav' }}
          header={
            <SideNavHeading
              heading="Buzz Community"
              subheading={window.location.host}
              headingHref="/"
              icon={<NavIcon icon={<Icon icon={BrandMark} size="sm" />} />}
            />
          }
          footer={
            <SideNavSection title="Account" isHeaderHidden>
              <NavLinkItem entry={SETTINGS_ENTRY} pathname={pathname} />
              <SideNavItem
                label={signOut.isPending ? 'Signing out…' : `Sign out ${session.username}`}
                icon={ArrowRightStartOnRectangleIcon}
                isDisabled={signOut.isPending}
                onClick={() =>
                  signOut.mutate(undefined, {
                    onError: () => showToast({ body: 'Sign-out did not reach the console. You are still signed in.', type: 'error' }),
                  })
                }
              />
            </SideNavSection>
          }>
          {NAV_GROUPS.map((group) => (
            <SideNavSection key={group.title} title={group.title}>
              {group.entries.map((entry) => (
                <NavLinkItem key={entry.path} entry={entry} pathname={pathname} />
              ))}
            </SideNavSection>
          ))}
        </SideNav>
      }>
      {/* Pages load on demand; the rail stays in place while one arrives, or fails to. */}
      <RouteErrorBoundary resetKey={pathname}>
        <Suspense fallback={<PageSpinner label="Loading page" />}>
          <Outlet />
        </Suspense>
      </RouteErrorBoundary>
    </AppShell>
  )
}
