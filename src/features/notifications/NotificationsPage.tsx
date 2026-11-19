/**
 * Phase 11 upgrade — Full Notification Center.
 *
 * Backed by the same live Realtime-subscribed useNotifications hook as the
 * Layout bell, so marking read here updates the bell badge instantly.
 *
 * New in this version:
 *   - Category filter tabs (All / Attendance / Geo-Fencing / System / KAREN)
 *   - Severity indicator (Critical/Warning/Info) derived from notification type
 *   - Deep-link: clicking an attendance/geo/admin notification navigates to the
 *     relevant module automatically
 *   - Empty-state per category explains what that category covers
 */
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell, CheckCheck, AlertTriangle, ClipboardCheck, Settings as SettingsIcon,
  MapPinned, Sparkles, AlertCircle, Info, ChevronRight, Search,
} from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { useNotifications } from '@/lib/queries/useNotifications';
import { primaryRole } from '@/types/domain';
import type { NotificationRow } from '@/lib/queries/useNotifications';

// ─── Category definitions ─────────────────────────────────────────────────────

type Category = 'ALL' | 'ATTENDANCE' | 'GEO_FENCING' | 'EARLY_EXIT' | 'SYSTEM' | 'ADMINISTRATIVE' | 'KAREN';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'ATTENDANCE', label: 'Attendance' },
  { id: 'EARLY_EXIT', label: 'Early Exit' },
  { id: 'GEO_FENCING', label: 'Geo-Fencing' },
  { id: 'ADMINISTRATIVE', label: 'Admin' },
  { id: 'KAREN', label: 'KAREN' },
  { id: 'SYSTEM', label: 'System' },
];

const CATEGORY_EMPTY: Record<Category, string> = {
  ALL: 'No notifications yet.',
  ATTENDANCE: 'No attendance alerts. All sessions are within normal thresholds.',
  GEO_FENCING: 'No geo-fencing alerts. All location verifications are passing.',
  EARLY_EXIT: 'No early exit events detected today.',
  ADMINISTRATIVE: 'No administrative alerts.',
  KAREN: 'No KAREN-generated alerts.',
  SYSTEM: 'No system events.',
};

// Map notification type to category filter
function typeToCategory(type: string): Category {
  if (type === 'ATTENDANCE') return 'ATTENDANCE';
  if (type === 'EARLY_EXIT') return 'EARLY_EXIT';
  if (type === 'GEO_FENCING') return 'GEO_FENCING';
  if (type === 'ADMINISTRATIVE') return 'ADMINISTRATIVE';
  if (type === 'KAREN') return 'KAREN';
  return 'SYSTEM';
}

// ─── Severity derivation ──────────────────────────────────────────────────────

type Severity = 'critical' | 'warning' | 'info';

function deriveSeverity(n: NotificationRow): Severity {
  const msg = (n.message ?? '').toLowerCase();
  const title = (n.title ?? '').toLowerCase();
  const type = n.type as string;
  if (msg.includes('critical') || msg.includes('violation') || msg.includes('failed') || title.includes('critical')) return 'critical';
  if (msg.includes('warning') || msg.includes('low') || msg.includes('threshold') || type === 'EARLY_EXIT') return 'warning';
  return 'info';
}

const SEVERITY_ICON = {
  critical: AlertTriangle,
  warning: AlertCircle,
  info: Info,
};

const SEVERITY_STYLES = {
  critical: { icon: 'text-status-error', bg: 'bg-status-error/10', badge: 'bg-status-error/10 text-status-error' },
  warning: { icon: 'text-status-warning', bg: 'bg-status-warning/10', badge: 'bg-status-warning/10 text-status-warning' },
  info: { icon: 'text-status-info', bg: 'bg-status-info/10', badge: 'bg-status-info/10 text-status-info' },
};

const TYPE_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  EARLY_EXIT: AlertTriangle,
  ATTENDANCE: ClipboardCheck,
  ADMINISTRATIVE: SettingsIcon,
  GEO_FENCING: MapPinned,
  KAREN: Sparkles,
  SYSTEM: Bell,
};

// Deep-link route for each notification type
function getNotificationRoute(n: NotificationRow, roleBasePath: string): string | null {
  const type = n.type as string;
  switch (type) {
    case 'ATTENDANCE': return `${roleBasePath}/attendance`;
    case 'EARLY_EXIT': return `${roleBasePath}/geofencing`;
    case 'GEO_FENCING': return `${roleBasePath}/geofencing`;
    case 'ADMINISTRATIVE': return `${roleBasePath}/settings`;
    case 'KAREN': return `${roleBasePath}/karen`;
    default: return null;
  }
}

// ─── Main page ────────────────────────────────────────────────────────────────

const NotificationsPage: React.FC = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const role = primaryRole(profile!);
  const roleBasePath = `/${(role ?? 'student').toLowerCase().replace('_', '-')}`;

  const { rows, isLoading, unreadCount, markRead, markAllRead } = useNotifications(profile?.user_id ?? null, 200);

  const [activeCategory, setActiveCategory] = useState<Category>('ALL');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let list = rows;
    if (activeCategory !== 'ALL') {
      list = list.filter((n) => typeToCategory(n.type) === activeCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((n) => n.title.toLowerCase().includes(q) || (n.message ?? '').toLowerCase().includes(q));
    }
    return list;
  }, [rows, activeCategory, search]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Partial<Record<Category, number>> = { ALL: rows.filter(r => !r.read_at).length };
    for (const cat of CATEGORIES.slice(1)) {
      const unread = rows.filter(r => !r.read_at && typeToCategory(r.type) === cat.id).length;
      if (unread > 0) counts[cat.id] = unread;
    }
    return counts;
  }, [rows]);

  return (
    <div className="space-y-5 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <Bell size={22} className="text-accent-primary" />
            Notifications
          </h2>
          <p className="text-sm text-text-muted mt-1">
            {unreadCount > 0 ? `${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}` : "You're all caught up."}
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            onClick={() => void markAllRead()}
            className="px-4 py-2 bg-panel border border-border-default rounded-lg text-sm text-text-secondary hover:text-text-primary hover:border-accent-primary/50 transition-all flex items-center gap-2"
          >
            <CheckCheck size={16} /> Mark all read
          </button>
        )}
      </div>

      {/* Search + Category tabs */}
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notifications..."
            className="w-full pl-9 pr-3 py-2 bg-main border border-border-default rounded-lg text-sm text-text-primary outline-none focus:border-accent-primary placeholder-text-muted"
          />
        </div>

        {/* Category tabs */}
        <div className="flex bg-panel border border-border-default rounded-lg p-1 gap-0.5 overflow-x-auto flex-shrink-0">
          {CATEGORIES.map((cat) => {
            const count = categoryCounts[cat.id];
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 ${
                  activeCategory === cat.id
                    ? 'bg-accent-primary text-white shadow-sm'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {cat.label}
                {count !== undefined && count > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${activeCategory === cat.id ? 'bg-white/20 text-white' : 'bg-status-error/10 text-status-error'}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Notification list */}
      <div className="space-y-2">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-20 bg-panel border border-border-default rounded-xl animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 bg-panel border border-border-default rounded-xl text-center text-text-muted">
            <Bell size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">{search ? 'No matching notifications.' : CATEGORY_EMPTY[activeCategory]}</p>
          </div>
        ) : (
          filtered.map((n) => {
            const severity = deriveSeverity(n);
            const SeverityIcon = SEVERITY_ICON[severity];
            const TypeIcon = TYPE_ICON[n.type] ?? Bell;
            const styles = SEVERITY_STYLES[severity];
            const deepLink = getNotificationRoute(n, roleBasePath);
            const isUnread = !n.read_at;

            return (
              <div
                key={n.id}
                className={`bg-panel border rounded-xl flex items-start gap-4 transition-all ${
                  isUnread ? 'border-accent-primary/30 bg-accent-primary/5' : 'border-border-default'
                }`}
              >
                {/* Icon */}
                <div className={`p-3 rounded-xl flex-shrink-0 m-3 mr-0 ${styles.bg}`}>
                  <TypeIcon size={18} className={styles.icon} />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 py-3 pr-3">
                  <div className="flex items-start gap-2 justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {isUnread && <span className="w-2 h-2 rounded-full bg-accent-primary flex-shrink-0" />}
                        <p className="text-sm font-semibold text-text-primary">{n.title}</p>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${styles.badge}`}>
                          <SeverityIcon size={9} className="inline mr-0.5" />
                          {severity.charAt(0).toUpperCase() + severity.slice(1)}
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-main text-text-muted font-medium">
                          {n.type.replace('_', ' ')}
                        </span>
                      </div>
                      <p className="text-sm text-text-secondary mt-1">{n.message}</p>
                      <p className="text-xs text-text-muted mt-1.5">{new Date(n.created_at).toLocaleString()}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 mt-2">
                    {isUnread && (
                      <button
                        onClick={() => void markRead(n.id)}
                        className="text-xs text-text-muted hover:text-text-primary flex items-center gap-1 transition-colors"
                      >
                        <CheckCheck size={12} /> Mark read
                      </button>
                    )}
                    {deepLink && (
                      <button
                        onClick={() => {
                          if (isUnread) void markRead(n.id);
                          navigate(deepLink);
                        }}
                        className="text-xs text-accent-secondary hover:text-accent-primary flex items-center gap-1 transition-colors"
                      >
                        View details <ChevronRight size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default NotificationsPage;
