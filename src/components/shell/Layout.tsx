/**
 * Adapted from reference/IRIS-PAYROLL-main/components/Layout.tsx.
 *
 * Navigation order updated per requirements:
 *   Dashboard → Notifications → Attendance → Timetable → Students → Faculty →
 *   Departments → Geofencing → Reports → Documents → KAREN → Audit → Settings
 *
 * Notifications is now immediately after Dashboard (not near the bottom).
 * Sidebar section group labels added to distinguish: Overview, Academics,
 * Tools, Administration. DOM structure, className strings, notification
 * dropdown, theme toggle and mobile drawer preserved. Navigation driven by
 * react-router (useLocation/useNavigate).
 */
import React, { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, GraduationCap, Building2, CalendarRange, DoorOpen,
  MapPinned, ClipboardCheck, Bell, FileBarChart, FileText, Sparkles, Settings,
  ShieldCheck, LogOut, Moon, Sun, Menu, X as CloseIcon, CalendarCheck2,
} from 'lucide-react';
import type { SessionProfile, NavId, NavItem } from '@/types/domain';
import { primaryRole } from '@/types/domain';
import { useNotifications } from '@/lib/queries/useNotifications';

interface LayoutProps {
  profile: SessionProfile;
  children: React.ReactNode;
  onLogout: () => void;
}

const ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  dashboard: LayoutDashboard,
  students: Users,
  faculty: GraduationCap,
  departments: Building2,
  timetable: CalendarRange,
  classrooms: DoorOpen,
  geofencing: MapPinned,
  attendance: ClipboardCheck,
  notifications: Bell,
  reports: FileBarChart,
  documents: FileText,
  karen: Sparkles,
  settings: Settings,
  audit: ShieldCheck,
  'my-attendance': CalendarCheck2,
  'my-timetable': CalendarRange,
};

/** Section group dividers for the sidebar. Group label appears above items. */
type NavGroup = {
  label: string;
  items: NavItem[];
};

/** Role-scoped navigation — Notifications always immediately after Dashboard. */
function navGroupsForRole(role: ReturnType<typeof primaryRole>): NavGroup[] {
  const base = (id: NavId, label: string): NavItem => ({ id, label, icon: id });

  switch (role) {
    case 'ADMIN':
      return [
        {
          label: 'Overview',
          items: [
            base('dashboard', 'Dashboard'),
            base('notifications', 'Notifications'),
          ],
        },
        {
          label: 'Academics',
          items: [
            base('attendance', 'Attendance'),
            base('timetable', 'Timetable'),
            base('students', 'Students'),
            base('faculty', 'Faculty'),
            base('departments', 'Departments'),
            base('geofencing', 'Geo-Fencing'),
          ],
        },
        {
          label: 'Tools',
          items: [
            base('reports', 'Reports'),
            base('documents', 'Documents'),
            base('karen', 'KAREN AI'),
          ],
        },
        {
          label: 'Administration',
          items: [
            base('audit', 'Audit Log'),
            base('settings', 'Settings'),
          ],
        },
      ];

    case 'HOD':
      return [
        {
          label: 'Overview',
          items: [
            base('dashboard', 'Dashboard'),
            base('notifications', 'Notifications'),
          ],
        },
        {
          label: 'Academics',
          items: [
            base('attendance', 'Attendance'),
            base('timetable', 'Timetable'),
            base('students', 'Students'),
            base('faculty', 'Faculty'),
            base('departments', 'Departments'),
            base('geofencing', 'Geo-Fencing'),
          ],
        },
        {
          label: 'Tools',
          items: [
            base('reports', 'Reports'),
            base('documents', 'Documents'),
            base('karen', 'KAREN AI'),
          ],
        },
      ];

    case 'FACULTY':
    case 'MENTOR':
    case 'CLASS_INCHARGE':
      return [
        {
          label: 'Overview',
          items: [
            base('dashboard', 'Dashboard'),
            base('notifications', 'Notifications'),
          ],
        },
        {
          label: 'Academics',
          items: [
            base('attendance', 'Attendance'),
            base('timetable', 'Timetable'),
            base('students', 'Students'),
          ],
        },
        {
          label: 'Tools',
          items: [
            base('reports', 'Reports'),
            base('documents', 'Documents'),
            base('karen', 'KAREN AI'),
          ],
        },
      ];

    case 'STUDENT':
      return [
        {
          label: 'Overview',
          items: [
            base('dashboard', 'Overview'),
            base('notifications', 'Notifications'),
          ],
        },
        {
          label: 'My Academics',
          items: [
            base('my-attendance', 'Attendance'),
            base('my-timetable', 'Timetable'),
          ],
        },
        {
          label: 'Tools',
          items: [
            base('documents', 'Documents'),
            base('karen', 'KAREN AI'),
          ],
        },
      ];

    default:
      return [{ label: 'Overview', items: [base('dashboard', 'Dashboard')] }];
  }
}

/** Flatten nav groups to a flat list for legacy code compatibility. */
function flattenGroups(groups: NavGroup[]): NavItem[] {
  return groups.flatMap((g) => g.items);
}

const Layout: React.FC<LayoutProps> = ({ profile, children, onLogout }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const [showNotifications, setShowNotifications] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const notificationRef = useRef<HTMLDivElement>(null);

  const role = primaryRole(profile);
  const navGroups = navGroupsForRole(role);
  const navItems = flattenGroups(navGroups);
  const roleBasePath = `/${(role ?? 'student').toLowerCase().replace('_', '-')}`;
  const { rows: recentNotifications, unreadCount, markRead } = useNotifications(profile.user_id, 10);

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');

    const handleClickOutside = (event: MouseEvent) => {
      if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));

  const currentLabel =
    navItems.find((item) => location.pathname.startsWith(`${roleBasePath}/${item.id}`))?.label ??
    'Dashboard';

  const NavContent = () => (
    <>
      {/* Brand */}
      <div className="p-5 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-primary to-accent-secondary flex items-center justify-center shadow-[0_0_15px_rgba(47,91,255,0.3)]">
            <span className="text-white font-bold text-sm">C</span>
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-text-primary leading-none">KAREN</h1>
            <p className="text-[10px] text-text-muted tracking-widest uppercase font-medium mt-0.5">CIMS</p>
          </div>
        </div>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 px-3 overflow-y-auto pb-2">
        {navGroups.map((group, groupIdx) => (
          <div key={groupIdx} className={groupIdx > 0 ? 'mt-4' : 'mt-2'}>
            <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted/60">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const path = `${roleBasePath}/${item.id}`;
                const isActive = location.pathname.startsWith(path);
                const Icon = ICONS[item.icon] ?? LayoutDashboard;
                const isNotifications = item.id === 'notifications';
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      navigate(path);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 group ${
                      isActive
                        ? 'bg-accent-primary text-white shadow-[0_2px_12px_rgba(47,91,255,0.25)]'
                        : 'text-text-secondary hover:bg-main hover:text-text-primary'
                    }`}
                  >
                    <div className="relative flex-shrink-0">
                      <Icon size={17} className={isActive ? 'text-white' : 'text-text-muted group-hover:text-accent-secondary'} />
                      {/* Notification badge on the nav icon */}
                      {isNotifications && unreadCount > 0 && !isActive && (
                        <span className="absolute -top-1 -right-1 w-2 h-2 bg-status-error rounded-full" />
                      )}
                    </div>
                    <span className="font-medium text-sm flex-1 text-left">{item.label}</span>
                    {isNotifications && unreadCount > 0 && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${isActive ? 'bg-white/20 text-white' : 'bg-status-error/10 text-status-error'}`}>
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* User footer */}
      <div className="p-3 border-t border-border-default mt-auto">
        <div className="px-3 py-2 mb-1">
          <p className="text-[10px] text-text-muted uppercase tracking-wider">Logged in as</p>
          <p className="text-sm font-semibold text-text-primary truncate mt-0.5">{profile.full_name}</p>
          <p className="text-[10px] text-accent-secondary uppercase tracking-wider font-bold mt-0.5">
            {(role ?? 'unassigned').replace('_', ' ')}
          </p>
        </div>
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-status-error/70 hover:bg-status-error/10 hover:text-status-error transition-colors"
        >
          <LogOut size={17} />
          <span className="font-medium text-sm">Sign Out</span>
        </button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-main flex transition-colors duration-300">
      <aside className="w-60 bg-panel border-r border-border-default hidden md:flex flex-col fixed h-full z-10 transition-colors duration-300">
        <NavContent />
      </aside>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="w-60 bg-panel border-r border-border-default flex flex-col h-full animate-in slide-in-from-left duration-200 shadow-2xl">
            <NavContent />
          </div>
          <div
            className="flex-1 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={() => setMobileMenuOpen(false)}
          />
        </div>
      )}

      <main className="flex-1 md:ml-60 relative min-w-0">
        {/* Top header */}
        <header className="h-14 bg-main/80 backdrop-blur-md border-b border-border-default sticky top-0 z-20 px-4 md:px-6 flex justify-between items-center transition-colors duration-300">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden p-2 text-text-secondary hover:text-text-primary transition-colors"
            >
              <Menu size={22} />
            </button>
            <div>
              <h2 className="text-sm font-semibold text-text-primary capitalize">{currentLabel}</h2>
              <p className="text-[10px] text-text-muted hidden sm:block">
                {new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 md:gap-2">
            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              className="p-2 text-text-muted hover:text-text-primary transition-colors hover:bg-main rounded-lg border border-transparent hover:border-border-default"
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            {/* Notifications bell */}
            <div className="relative" ref={notificationRef}>
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className={`relative p-2 transition-colors rounded-lg ${showNotifications ? 'text-accent-primary bg-accent-primary/10' : 'text-text-muted hover:text-text-primary hover:bg-main'}`}
              >
                <Bell size={18} />
                {unreadCount > 0 && (
                  <span className="absolute top-1 right-1 w-2 h-2 bg-status-error rounded-full ring-2 ring-main" />
                )}
              </button>

              {showNotifications && (
                <div className="absolute top-full right-0 mt-2 w-80 bg-panel border border-border-default rounded-xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 origin-top-right z-50">
                  <div className="p-4 border-b border-border-default flex justify-between items-center bg-main/50">
                    <h3 className="font-semibold text-text-primary text-sm">Notifications</h3>
                    {unreadCount > 0 && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-accent-primary/10 text-accent-primary font-medium">
                        {unreadCount} unread
                      </span>
                    )}
                  </div>
                  <div className="max-h-[300px] overflow-y-auto">
                    {recentNotifications.length === 0 ? (
                      <div className="p-8 text-center text-text-muted text-sm">No notifications yet.</div>
                    ) : (
                      recentNotifications.map((n) => (
                        <button
                          key={n.id}
                          onClick={() => {
                            if (!n.read_at) void markRead(n.id);
                            setShowNotifications(false);
                            navigate(`${roleBasePath}/notifications`);
                          }}
                          className={`w-full text-left p-4 border-b border-border-default last:border-b-0 hover:bg-main/60 transition-colors ${!n.read_at ? 'bg-accent-primary/5' : ''}`}
                        >
                          <div className="flex items-start gap-2">
                            {!n.read_at && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent-primary flex-shrink-0" />}
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-text-primary truncate">{n.title}</p>
                              <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{n.message}</p>
                              <p className="text-[10px] text-text-muted mt-1">{new Date(n.created_at).toLocaleString()}</p>
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setShowNotifications(false);
                      navigate(`${roleBasePath}/notifications`);
                    }}
                    className="w-full p-3 text-center text-xs font-medium text-accent-secondary hover:bg-main/50 transition-colors border-t border-border-default"
                  >
                    View all notifications →
                  </button>
                </div>
              )}
            </div>

            {/* User avatar */}
            <div
              className="w-8 h-8 rounded-full bg-gradient-to-br from-accent-primary to-accent-secondary flex items-center justify-center text-white font-bold text-sm cursor-pointer shadow-[0_0_10px_rgba(47,91,255,0.2)]"
              title={`${profile.full_name} · ${role ?? 'unassigned'}`}
            >
              {profile.full_name.charAt(0).toUpperCase()}
            </div>
          </div>
        </header>

        <div className="p-4 md:p-6 pb-24 max-w-[100vw] overflow-x-hidden">{children}</div>
      </main>
    </div>
  );
};

export default Layout;
export { CloseIcon };
