/**
 * Admin Command Center Dashboard — Phase 6 upgrade.
 *
 * Replaces the placeholder session-info cards with a real institutional
 * KPI dashboard backed by:
 *   - get_dashboard_stats() RPC   → KPI cards (present/absent today, etc.)
 *   - get_department_strength()   → Department Strength donut chart
 *   - report_department_attendance_stats → Department Attendance bar chart
 *   - get_today_class_sessions()  → Today's Timetable mini-view
 *   - useNotifications             → Recent Notifications panel
 *
 * Charts use Recharts (already installed). All numbers are real — never
 * fabricated. Loading skeletons are shown on every card while data loads.
 *
 * Non-admin roles see a scoped view: their own department/section data,
 * as returned by the SECURITY INVOKER RPCs.
 */
import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, ClipboardCheck, AlertTriangle, TrendingUp, Building2,
  BookOpen, Bell, ArrowRight, RefreshCw, Calendar, Sparkles,
  CheckCircle2, XCircle, Clock, AlertCircle,
} from 'lucide-react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { useAuth } from '@/features/auth/AuthProvider';
import { primaryRole } from '@/types/domain';
import { useDashboardStats } from '@/lib/queries/useDashboardStats';
import { useNotifications } from '@/lib/queries/useNotifications';

// Chart colour palette — harmonizes with the existing KAREN design tokens
const PALETTE = ['#2F5BFF', '#2ED3B7', '#F5C451', '#FF5C5C', '#4C7DFF', '#a78bfa', '#34d399', '#f97316'];

// ─── Skeleton / Loading helpers ───────────────────────────────────────────────

const SkeletonBox = ({ className = '' }: { className?: string }) => (
  <div className={`bg-main animate-pulse rounded-lg ${className}`} />
);

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tone?: 'default' | 'success' | 'warning' | 'error' | 'info';
  loading?: boolean;
}

const TONE_CLASSES = {
  default: 'text-accent-primary bg-accent-primary/10',
  success: 'text-status-success bg-status-success/10',
  warning: 'text-status-warning bg-status-warning/10',
  error: 'text-status-error bg-status-error/10',
  info: 'text-status-info bg-status-info/10',
};

const KpiCard: React.FC<KpiCardProps> = ({ label, value, subtext, icon: Icon, tone = 'default', loading }) => (
  <div className="bg-panel border border-border-default rounded-xl p-5 hover:border-accent-primary/30 transition-all duration-200 hover:shadow-lg hover:shadow-accent-primary/5">
    <div className="flex justify-between items-start mb-3">
      <div className={`p-2.5 rounded-xl ${TONE_CLASSES[tone]}`}>
        <Icon size={20} />
      </div>
    </div>
    {loading ? (
      <>
        <SkeletonBox className="h-8 w-20 mb-2" />
        <SkeletonBox className="h-3 w-28" />
      </>
    ) : (
      <>
        <div className="text-3xl font-bold text-text-primary mb-1">{value}</div>
        <div className="text-xs text-text-muted uppercase tracking-wider font-medium">{label}</div>
        {subtext && <div className="text-xs text-text-secondary mt-1">{subtext}</div>}
      </>
    )}
  </div>
);

// ─── Chart Card wrapper ────────────────────────────────────────────────────────

const ChartCard: React.FC<{ title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode }> = ({ title, subtitle, children, action }) => (
  <div className="bg-panel border border-border-default rounded-xl p-5">
    <div className="flex items-start justify-between mb-4">
      <div>
        <h3 className="font-semibold text-text-primary text-sm">{title}</h3>
        {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
    {children}
  </div>
);

// ─── Custom tooltip for Recharts ──────────────────────────────────────────────

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-panel border border-border-default rounded-lg p-3 shadow-xl text-xs">
      {label && <p className="text-text-muted mb-1">{label}</p>}
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }} className="font-medium">{p.name}: {p.value}</p>
      ))}
    </div>
  );
};

// ─── Needs Attention ──────────────────────────────────────────────────────────

interface AttentionItem {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  detail?: string;
  route: string;
  label: string;
}

const SEVERITY_STYLES = {
  critical: 'border-status-error/30 bg-status-error/5',
  warning: 'border-status-warning/30 bg-status-warning/5',
  info: 'border-border-default bg-main/30',
};

const SEVERITY_ICON = {
  critical: <XCircle size={15} className="text-status-error flex-shrink-0" />,
  warning: <AlertCircle size={15} className="text-status-warning flex-shrink-0" />,
  info: <CheckCircle2 size={15} className="text-status-info flex-shrink-0" />,
};

// ─── Main Dashboard Page ───────────────────────────────────────────────────────

const DashboardPage: React.FC = () => {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const role = primaryRole(profile!);
  const roleBasePath = `/${(role ?? 'student').toLowerCase().replace('_', '-')}`;

  const { stats, deptStrength, deptAttendance, todaySessions, isLoading, error, refetch } = useDashboardStats();
  const { rows: notifications, unreadCount } = useNotifications(profile?.user_id ?? null, 5);

  // Derive "Needs Attention" items from real data
  const attentionItems = useMemo<AttentionItem[]>(() => {
    const items: AttentionItem[] = [];

    // Low attendance departments (below 75%)
    deptAttendance.forEach((d) => {
      if (d.present_rate_pct !== null && d.present_rate_pct < 75 && d.total_count && d.total_count > 0) {
        items.push({
          id: `dept-${d.department_id}`,
          severity: d.present_rate_pct < 50 ? 'critical' : 'warning',
          message: `${d.department_name ?? 'Unknown dept'} attendance is ${d.present_rate_pct}%`,
          detail: `${d.absent_count ?? 0} absent of ${d.total_count} records`,
          route: `${roleBasePath}/attendance`,
          label: 'View Attendance →',
        });
      }
    });

    // Unread notifications
    if (unreadCount > 0) {
      items.push({
        id: 'unread-notifications',
        severity: unreadCount > 5 ? 'warning' : 'info',
        message: `${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}`,
        route: `${roleBasePath}/notifications`,
        label: 'View Notifications →',
      });
    }

    // No sessions today
    if (!isLoading && todaySessions.length === 0) {
      items.push({
        id: 'no-sessions',
        severity: 'info',
        message: 'No class sessions scheduled for today',
        detail: 'Check the timetable for schedule conflicts.',
        route: `${roleBasePath}/timetable`,
        label: 'View Timetable →',
      });
    }

    return items.slice(0, 6);
  }, [deptAttendance, unreadCount, todaySessions, isLoading, roleBasePath]);

  // Donut chart data for Present vs Absent today
  const presentAbsentData = useMemo(() => {
    if (!stats || stats.total_records_today === 0) return [];
    return [
      { name: 'Present', value: stats.present_today },
      { name: 'Absent', value: stats.absent_today },
      { name: 'Other', value: Math.max(0, stats.total_records_today - stats.present_today - stats.absent_today) },
    ].filter(d => d.value > 0);
  }, [stats]);

  // Pie data for Department Strength
  const deptStrengthData = useMemo(() =>
    deptStrength.filter(d => d.student_count > 0).slice(0, 8),
    [deptStrength]
  );

  // Bar chart data for Department Attendance
  const deptAttendanceData = useMemo(() =>
    deptAttendance
      .filter(d => d.department_name && d.total_count && d.total_count > 0)
      .map(d => ({
        name: (d.department_name ?? '').length > 8 ? (d.department_name ?? '').slice(0, 8) + '…' : (d.department_name ?? ''),
        fullName: d.department_name ?? '',
        'Attendance %': d.present_rate_pct ?? 0,
        Present: d.present_count ?? 0,
        Absent: d.absent_count ?? 0,
      }))
      .slice(0, 8),
    [deptAttendance]
  );

  if (!profile) return null;

  const firstName = profile.full_name.split(' ')[0];

  return (
    <div className="space-y-5 animate-in fade-in duration-500">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text-primary">
            Good {getGreeting()}, {firstName}
          </h2>
          <p className="text-text-secondary text-sm mt-0.5">
            Here's what's happening at your institution today.
          </p>
        </div>
        <button
          onClick={refetch}
          disabled={isLoading}
          className="px-3 py-2 bg-panel border border-border-default rounded-lg text-sm text-text-secondary hover:text-text-primary transition-colors flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="p-3 bg-status-error/10 border border-status-error/20 rounded-xl text-sm text-status-error flex items-center gap-2">
          <AlertTriangle size={15} />
          {error} — some statistics may be unavailable.
        </div>
      )}

      {/* ── Row 1: KPI Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Total Students"
          value={stats?.total_students ?? '—'}
          icon={Users}
          tone="default"
          loading={isLoading}
        />
        <KpiCard
          label="Present Today"
          value={stats?.present_today ?? '—'}
          subtext={stats && stats.total_records_today > 0 ? `${stats.attendance_pct}% attendance` : undefined}
          icon={CheckCircle2}
          tone="success"
          loading={isLoading}
        />
        <KpiCard
          label="Absent Today"
          value={stats?.absent_today ?? '—'}
          icon={XCircle}
          tone={stats && stats.absent_today > (stats.present_today ?? 0) ? 'error' : 'warning'}
          loading={isLoading}
        />
        <KpiCard
          label="Active Departments"
          value={stats?.active_departments ?? '—'}
          icon={Building2}
          tone="info"
          loading={isLoading}
        />
        <KpiCard
          label="Classes Today"
          value={stats?.total_classes_today ?? '—'}
          subtext={stats && stats.active_classes_today > 0 ? `${stats.active_classes_today} in progress` : undefined}
          icon={BookOpen}
          tone="default"
          loading={isLoading}
        />
        <KpiCard
          label="Attendance Rate"
          value={stats ? `${stats.attendance_pct}%` : '—'}
          icon={TrendingUp}
          tone={stats && stats.attendance_pct < 75 ? 'error' : stats && stats.attendance_pct < 85 ? 'warning' : 'success'}
          loading={isLoading}
        />
        <KpiCard
          label="Active Geo-Fences"
          value={stats?.active_geofences ?? '—'}
          icon={ClipboardCheck}
          tone="info"
          loading={isLoading}
        />
        <KpiCard
          label="Unread Alerts"
          value={unreadCount}
          icon={Bell}
          tone={unreadCount > 5 ? 'warning' : 'default'}
          loading={isLoading}
        />
      </div>

      {/* ── Row 2: Department Strength + Present vs Absent ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Department Strength" subtitle="Student distribution by department">
          {isLoading ? (
            <SkeletonBox className="h-56" />
          ) : deptStrengthData.length === 0 ? (
            <EmptyChart message="No student data available." />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={deptStrengthData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="student_count"
                  nameKey="department_name"
                >
                  {deptStrengthData.map((_, idx) => (
                    <Cell key={idx} fill={PALETTE[idx % PALETTE.length]} strokeWidth={0} />
                  ))}
                </Pie>
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload as { department_name: string; student_count: number };
                    const total = deptStrengthData.reduce((s, x) => s + x.student_count, 0);
                    return (
                      <div className="bg-panel border border-border-default rounded-lg p-3 shadow-xl text-xs">
                        <p className="font-semibold text-text-primary">{d.department_name}</p>
                        <p className="text-text-muted mt-0.5">{d.student_count} students · {total > 0 ? Math.round((d.student_count / total) * 100) : 0}%</p>
                      </div>
                    );
                  }}
                />
                <Legend
                  formatter={(value) => <span className="text-xs text-text-secondary">{value}</span>}
                  iconType="circle"
                  iconSize={8}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Today's Attendance" subtitle="Present vs Absent across all sessions today">
          {isLoading ? (
            <SkeletonBox className="h-56" />
          ) : presentAbsentData.length === 0 ? (
            <EmptyChart message="No attendance records for today." />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={presentAbsentData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="value"
                  nameKey="name"
                >
                  {presentAbsentData.map((entry, idx) => {
                    const colors: Record<string, string> = { Present: '#2ED3B7', Absent: '#FF5C5C', Other: '#6b7394' };
                    return <Cell key={idx} fill={colors[entry.name] ?? PALETTE[idx % PALETTE.length]} strokeWidth={0} />;
                  })}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  formatter={(value) => <span className="text-xs text-text-secondary">{value}</span>}
                  iconType="circle"
                  iconSize={8}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      {/* ── Row 3: Department Attendance Bar Chart ── */}
      <ChartCard
        title="Department Attendance"
        subtitle="Overall attendance rate per department (from all recorded sessions)"
        action={
          <button
            onClick={() => navigate(`${roleBasePath}/reports`)}
            className="text-xs text-accent-secondary hover:text-accent-primary flex items-center gap-1 transition-colors"
          >
            Full Report <ArrowRight size={12} />
          </button>
        }
      >
        {isLoading ? (
          <SkeletonBox className="h-52" />
        ) : deptAttendanceData.length === 0 ? (
          <EmptyChart message="No attendance data. Sessions must be created and recorded first." />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={deptAttendanceData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0]?.payload as { fullName: string; 'Attendance %': number; Present: number; Absent: number };
                  return (
                    <div className="bg-panel border border-border-default rounded-lg p-3 shadow-xl text-xs">
                      <p className="font-semibold text-text-primary mb-1">{d.fullName}</p>
                      <p className="text-status-success">Present: {d.Present}</p>
                      <p className="text-status-error">Absent: {d.Absent}</p>
                      <p className="text-text-muted mt-1">Rate: {d['Attendance %']}%</p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="Attendance %" fill="#2F5BFF" radius={[4, 4, 0, 0]}>
                {deptAttendanceData.map((entry, idx) => (
                  <Cell
                    key={idx}
                    fill={(entry['Attendance %'] as number) < 75 ? '#FF5C5C' : (entry['Attendance %'] as number) < 85 ? '#F5C451' : '#2ED3B7'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* ── Row 4: Absenteeism table ── */}
      {(deptAttendanceData.length > 0 || isLoading) && (
        <ChartCard
          title="Departments by Absenteeism"
          subtitle="Ranked from highest to lowest absence rate — focus on highlighted departments"
          action={
            <button
              onClick={() => navigate(`${roleBasePath}/attendance`)}
              className="text-xs text-accent-secondary hover:text-accent-primary flex items-center gap-1 transition-colors"
            >
              Live Attendance <ArrowRight size={12} />
            </button>
          }
        >
          {isLoading ? (
            <SkeletonBox className="h-32" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left min-w-[400px]">
                <thead>
                  <tr className="text-[10px] text-text-muted uppercase tracking-wider border-b border-border-default">
                    <th className="pb-2 font-medium">Department</th>
                    <th className="pb-2 font-medium text-right">Present</th>
                    <th className="pb-2 font-medium text-right">Absent</th>
                    <th className="pb-2 font-medium text-right">Absence %</th>
                    <th className="pb-2 font-medium text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-default">
                  {[...deptAttendance]
                    .filter(d => d.total_count && d.total_count > 0)
                    .sort((a, b) => (b.absent_count ?? 0) / Math.max(b.total_count ?? 1, 1) - (a.absent_count ?? 0) / Math.max(a.total_count ?? 1, 1))
                    .slice(0, 6)
                    .map((d, i) => {
                      const absPct = d.total_count ? Math.round(((d.absent_count ?? 0) / d.total_count) * 100) : 0;
                      return (
                        <tr key={i} className={`text-sm ${absPct > 40 ? 'bg-status-error/5' : ''}`}>
                          <td className="py-2.5 font-medium text-text-primary">{d.department_name ?? '—'}</td>
                          <td className="py-2.5 text-right text-status-success">{d.present_count ?? 0}</td>
                          <td className="py-2.5 text-right text-status-error">{d.absent_count ?? 0}</td>
                          <td className="py-2.5 text-right font-bold"
                            style={{ color: absPct > 40 ? '#FF5C5C' : absPct > 25 ? '#F5C451' : '#2ED3B7' }}>
                            {absPct}%
                          </td>
                          <td className="py-2.5 text-right">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${absPct > 40 ? 'bg-status-error/10 text-status-error' : absPct > 25 ? 'bg-status-warning/10 text-status-warning' : 'bg-status-success/10 text-status-success'}`}>
                              {absPct > 40 ? 'Critical' : absPct > 25 ? 'Watch' : 'Good'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  {deptAttendance.filter(d => d.total_count && d.total_count > 0).length === 0 && (
                    <tr><td colSpan={5} className="py-6 text-center text-text-muted text-xs">No attendance data yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
      )}

      {/* ── Row 5: Needs Attention + Recent Notifications ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Needs Attention */}
        <div className="bg-panel border border-border-default rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle size={16} className="text-status-warning" />
            <h3 className="font-semibold text-text-primary text-sm">Needs Attention</h3>
          </div>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <SkeletonBox key={i} className="h-14" />)}
            </div>
          ) : attentionItems.length === 0 ? (
            <div className="flex items-center gap-3 p-4 bg-status-success/5 border border-status-success/20 rounded-xl">
              <CheckCircle2 size={20} className="text-status-success flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-text-primary">Everything looks good</p>
                <p className="text-xs text-text-muted mt-0.5">No attention items right now.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {attentionItems.map((item) => (
                <div key={item.id} className={`p-3 border rounded-xl ${SEVERITY_STYLES[item.severity]}`}>
                  <div className="flex items-start gap-2">
                    {SEVERITY_ICON[item.severity]}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary">{item.message}</p>
                      {item.detail && <p className="text-xs text-text-muted mt-0.5">{item.detail}</p>}
                    </div>
                  </div>
                  <button
                    onClick={() => navigate(item.route)}
                    className="mt-2 text-xs text-accent-secondary hover:text-accent-primary flex items-center gap-1 transition-colors"
                  >
                    {item.label} <ArrowRight size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Notifications */}
        <div className="bg-panel border border-border-default rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Bell size={16} className="text-accent-primary" />
              <h3 className="font-semibold text-text-primary text-sm">Recent Notifications</h3>
            </div>
            <button
              onClick={() => navigate(`${roleBasePath}/notifications`)}
              className="text-xs text-accent-secondary hover:text-accent-primary flex items-center gap-1 transition-colors"
            >
              View All <ArrowRight size={12} />
            </button>
          </div>
          {notifications.length === 0 ? (
            <div className="py-8 text-center text-text-muted text-sm">
              <Bell size={24} className="mx-auto mb-2 opacity-30" />
              No notifications yet.
            </div>
          ) : (
            <div className="space-y-2">
              {notifications.slice(0, 5).map((n) => (
                <button
                  key={n.id}
                  onClick={() => navigate(`${roleBasePath}/notifications`)}
                  className={`w-full text-left p-3 rounded-xl border transition-colors hover:border-accent-primary/30 ${!n.read_at ? 'border-accent-primary/20 bg-accent-primary/5' : 'border-border-default'}`}
                >
                  <div className="flex items-start gap-2">
                    {!n.read_at && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent-primary flex-shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-text-primary truncate">{n.title}</p>
                      <p className="text-xs text-text-muted mt-0.5 line-clamp-1">{n.message}</p>
                      <p className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
                        <Clock size={9} /> {new Date(n.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Row 6: Today's Timetable ── */}
      <div className="bg-panel border border-border-default rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Calendar size={16} className="text-accent-primary" />
            <div>
              <h3 className="font-semibold text-text-primary text-sm">Today's Sessions</h3>
              <p className="text-xs text-text-muted">
                {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}
              </p>
            </div>
          </div>
          <button
            onClick={() => navigate(`${roleBasePath}/attendance`)}
            className="text-xs text-accent-secondary hover:text-accent-primary flex items-center gap-1 transition-colors"
          >
            Live Attendance <ArrowRight size={12} />
          </button>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {[1, 2, 3, 4].map(i => <SkeletonBox key={i} className="h-24" />)}
          </div>
        ) : todaySessions.length === 0 ? (
          <div className="py-8 text-center text-text-muted text-sm">
            <Calendar size={24} className="mx-auto mb-2 opacity-30" />
            <p>No class sessions today.</p>
            <p className="text-xs mt-1">Sessions are created from the timetable via the attendance engine.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {todaySessions.map((s) => {
              const now = new Date();
              const start = new Date(s.scheduled_start);
              const end = new Date(s.scheduled_end);
              const isCurrent = now >= start && now <= end;
              const isPast = now > end;
              const attendancePct = s.total_count > 0 ? Math.round((s.present_count / s.total_count) * 100) : null;

              return (
                <div
                  key={s.session_id}
                  className={`p-3 rounded-xl border transition-colors ${
                    isCurrent
                      ? 'border-accent-primary/40 bg-accent-primary/5 ring-1 ring-accent-primary/20'
                      : isPast
                      ? 'border-border-default bg-main/30 opacity-60'
                      : 'border-border-default'
                  }`}
                >
                  {isCurrent && (
                    <span className="text-[10px] font-bold text-accent-primary uppercase tracking-wider flex items-center gap-1 mb-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-pulse" />
                      In Progress
                    </span>
                  )}
                  <p className="text-sm font-semibold text-text-primary truncate">{s.subject_code} — {s.subject_name}</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    {s.section_year ? `Year ${s.section_year}` : ''}{s.section_name ? `-${s.section_name}` : ''}
                    {s.classroom_name ? ` · ${s.classroom_name}` : ''}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    {start.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} – {end.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                  {attendancePct !== null && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-main rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${attendancePct >= 75 ? 'bg-status-success' : attendancePct >= 50 ? 'bg-status-warning' : 'bg-status-error'}`}
                          style={{ width: `${attendancePct}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-text-muted whitespace-nowrap">{attendancePct}%</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── KAREN Quick Ask Widget ── */}
      <div className="bg-panel border border-border-default rounded-xl p-5 bg-gradient-to-br from-accent-primary/5 to-transparent">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={16} className="text-accent-primary" />
          <h3 className="font-semibold text-text-primary text-sm">Ask KAREN</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            'Which department has the lowest attendance?',
            "What's today's schedule?",
            'Show students below attendance threshold.',
            'List recent geo-fence alerts.',
          ].map((prompt) => (
            <button
              key={prompt}
              onClick={() => navigate(`${roleBasePath}/karen`, { state: { prompt } })}
              className="text-xs px-3 py-1.5 bg-main border border-border-default rounded-full text-text-secondary hover:text-text-primary hover:border-accent-primary/40 transition-all"
            >
              {prompt}
            </button>
          ))}
          <button
            onClick={() => navigate(`${roleBasePath}/karen`)}
            className="text-xs px-3 py-1.5 bg-accent-primary/10 border border-accent-primary/30 rounded-full text-accent-primary hover:bg-accent-primary hover:text-white transition-all flex items-center gap-1"
          >
            Open KAREN <ArrowRight size={11} />
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

const EmptyChart: React.FC<{ message: string }> = ({ message }) => (
  <div className="h-56 flex items-center justify-center text-text-muted text-xs text-center">
    <div>
      <div className="w-8 h-8 rounded-full bg-main flex items-center justify-center mx-auto mb-2 text-text-muted/50">
        <AlertCircle size={16} />
      </div>
      {message}
    </div>
  </div>
);

export default DashboardPage;
