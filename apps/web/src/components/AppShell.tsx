import clsx from 'clsx';
import {
  BarChart3,
  BookOpen,
  Brain,
  Home,
  Layers,
  LogOut,
  Search,
  Settings,
  type LucideIcon,
  Workflow,
} from 'lucide-react';
import { Navigate, NavLink, Outlet } from 'react-router';
import { useLogout, useSession } from '../features/auth/session';
import { StudyTimerHost } from '../features/timer/StudyTimer';
import { TimerToggle } from '../features/timer/TimerToggle';
import { t } from '../i18n';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Only in the desktop sidebar (the phone bar keeps five entries). */
  desktopOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: t.nav.home, icon: Home },
  { to: '/library', label: t.nav.library, icon: BookOpen },
  { to: '/search', label: t.nav.search, icon: Search, desktopOnly: true },
  { to: '/review', label: t.nav.review, icon: Layers },
  { to: '/memory', label: t.nav.memory, icon: Brain },
  { to: '/diagrams', label: t.nav.diagrams, icon: Workflow, desktopOnly: true },
  { to: '/stats', label: t.nav.stats, icon: BarChart3, desktopOnly: true },
  { to: '/settings', label: t.nav.settings, icon: Settings },
];

/** Authenticated layout: sidebar on desktop, bottom bar on mobile (SPEC §4). */
export function AppShell() {
  const session = useSession();
  const logout = useLogout();

  if (session.isPending) return <p className="p-6 text-text-muted">{t.common.loading}</p>;
  if (!session.data?.authenticated) return <Navigate to="/login" replace />;

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <nav
        aria-label={t.nav.mainNavigation}
        className="border-border bg-surface hidden w-56 shrink-0 flex-col border-r px-3 py-5 lg:flex"
      >
        <p className="mb-6 px-3 font-serif text-lg">{t.appName}</p>
        <ul className="flex-1 space-y-1">
          {NAV.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm',
                    isActive ? 'bg-surface-muted font-medium' : 'text-text-muted hover:text-text',
                  )
                }
              >
                <item.icon size={18} aria-hidden />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <TimerToggle nav />
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="text-text-muted hover:text-text flex items-center gap-3 rounded-md px-3 py-2 text-sm"
        >
          <LogOut size={18} aria-hidden />
          {t.nav.logout}
        </button>
      </nav>

      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>

      <nav
        aria-label={t.nav.mainNavigation}
        className="border-border bg-surface grid grid-cols-5 border-t pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {NAV.filter((item) => !item.desktopOnly).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              clsx(
                'flex flex-col items-center gap-1 py-2 text-xs',
                isActive ? 'text-text font-medium' : 'text-text-muted',
              )
            }
          >
            <item.icon size={20} aria-hidden />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <StudyTimerHost />
    </div>
  );
}
