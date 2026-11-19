/**
 * Phase 12 — Reports.
 *
 * docs/10_DOCUMENT_REPORT_ENGINE.md names the report categories (Attendance,
 * section/class, subject/session, department, campus entry/exit, geofence,
 * notification, audit, administrative) and one binding rule: "Generated
 * artifacts inherit user authorization scope." Every tab here queries a
 * security_invoker view/function (supabase/migrations/20260101002100_reports_views.sql)
 * — RLS on the underlying tables is what actually determines which rows
 * come back, exactly as EntityListPage-backed pages already work elsewhere.
 *
 * CSV export ("Download") is real and client-side (src/lib/csv.ts) — no
 * fabricated PDF/DOCX. Those richer formats are Phase 13's job (Document
 * Generation), which will render this same data server-side.
 */
import React, { useEffect, useState } from 'react';
import { Download, FileBarChart } from 'lucide-react';
import EntityListPage, { type EntityColumn } from '@/components/ui/EntityListPage';
import FilterSelect from '@/components/ui/FilterSelect';
import { useLookupOptions } from '@/lib/queries/useLookupOptions';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasPermission } from '@/types/domain';
import { supabase } from '@/lib/supabase';
import { toCsv, downloadCsv } from '@/lib/csv';
import type { Database } from '@/types/database';

type SectionStats = Database['public']['Views']['report_section_attendance_stats']['Row'];
type DeptStats = Database['public']['Views']['report_department_attendance_stats']['Row'];
type EntryExitRow = Database['public']['Functions']['report_campus_entry_exit']['Returns'][number];
type AuditRow = Database['public']['Tables']['audit_logs']['Row'];
type RoleAssignmentRow = Database['public']['Functions']['report_role_assignments']['Returns'][number];

const TABS = ['attendance', 'department', 'entry-exit', 'audit', 'administrative'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  attendance: 'Section / Subject Attendance',
  department: 'Department Attendance',
  'entry-exit': 'Campus Entry / Exit',
  audit: 'Audit',
  administrative: 'Role Assignments',
};

function useReportQuery<T>(fetcher: () => Promise<T[]>, deps: unknown[]) {
  const [rows, setRows] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetcher()
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { rows, isLoading, error };
}

const ReportsPage: React.FC = () => {
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>('attendance');
  const [departmentId, setDepartmentId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const { options: departments } = useLookupOptions('departments', 'id, name');

  const canReadAudit = hasPermission(profile, 'audit.read');
  const visibleTabs = TABS.filter((t) => t !== 'audit' || canReadAudit);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h2 className="text-2xl font-bold text-text-primary flex items-center gap-2">
          <FileBarChart size={24} /> Reports
        </h2>
        <p className="text-sm text-text-muted mt-1">
          Every report below reflects only data you are already authorised to see.
        </p>
      </div>

      <div className="flex bg-panel border border-border-default rounded-lg p-1 w-fit flex-wrap">
        {visibleTabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${tab === t ? 'bg-accent-primary text-white shadow-md' : 'text-text-muted hover:text-text-primary'}`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === 'attendance' && <SectionAttendanceReport />}
      {tab === 'department' && <DepartmentAttendanceReport />}
      {tab === 'entry-exit' && (
        <EntryExitReport
          departmentId={departmentId}
          setDepartmentId={setDepartmentId}
          fromDate={fromDate}
          toDate={toDate}
          setFromDate={setFromDate}
          setToDate={setToDate}
          departments={departments as Array<{ id: string; name: string }>}
        />
      )}
      {tab === 'audit' && canReadAudit && (
        <AuditReport fromDate={fromDate} toDate={toDate} setFromDate={setFromDate} setToDate={setToDate} />
      )}
      {tab === 'administrative' && (
        <RoleAssignmentsReport departmentId={departmentId} setDepartmentId={setDepartmentId} departments={departments as Array<{ id: string; name: string }>} />
      )}
    </div>
  );
};

const SectionAttendanceReport: React.FC = () => {
  const { rows, isLoading } = useReportQuery<SectionStats>(async () => {
    const { data, error } = await supabase.from('report_section_attendance_stats').select('*');
    if (error) throw error;
    return data ?? [];
  }, []);

  const columns: EntityColumn<SectionStats>[] = [
    { key: 'section', header: 'Section', render: (r) => r.section_name ?? '—' },
    { key: 'subject', header: 'Subject', render: (r) => r.subject_name ?? '—' },
    { key: 'present', header: 'Present', render: (r) => r.present_count ?? 0 },
    { key: 'late', header: 'Late', render: (r) => r.late_count ?? 0 },
    { key: 'absent', header: 'Absent', render: (r) => r.absent_count ?? 0 },
    { key: 'flagged', header: 'Flagged', render: (r) => r.flagged_count ?? 0 },
    { key: 'total', header: 'Total', render: (r) => r.total_count ?? 0 },
    {
      key: 'rate',
      header: 'Present Rate',
      render: (r) => (
        <span className={`font-medium ${(r.present_rate_pct ?? 0) < 75 ? 'text-status-error' : 'text-status-success'}`}>
          {r.present_rate_pct ?? 0}%
        </span>
      ),
    },
  ];

  return (
    <EntityListPage
      title="Section / Subject Attendance"
      columns={columns}
      rows={rows}
      rowKey={(r) => `${r.section_id}-${r.subject_id}`}
      searchQuery=""
      onSearchChange={() => {}}
      isSearching={isLoading}
      emptyMessage="No attendance records yet."
      headerActions={
        <button
          onClick={() =>
            downloadCsv(
              'section-attendance-report',
              toCsv(rows, [
                { key: 'section_name', header: 'Section' },
                { key: 'subject_name', header: 'Subject' },
                { key: 'present_count', header: 'Present' },
                { key: 'late_count', header: 'Late' },
                { key: 'absent_count', header: 'Absent' },
                { key: 'flagged_count', header: 'Flagged' },
                { key: 'total_count', header: 'Total' },
                { key: 'present_rate_pct', header: 'Present Rate %' },
              ])
            )
          }
          disabled={rows.length === 0}
          className="px-4 py-2 bg-panel border border-border-default rounded-lg text-sm text-text-secondary hover:text-text-primary hover:border-accent-primary/50 transition-all flex items-center gap-2 disabled:opacity-40"
        >
          <Download size={16} /> Download CSV
        </button>
      }
    />
  );
};

const DepartmentAttendanceReport: React.FC = () => {
  const { rows, isLoading } = useReportQuery<DeptStats>(async () => {
    const { data, error } = await supabase.from('report_department_attendance_stats').select('*');
    if (error) throw error;
    return data ?? [];
  }, []);

  const columns: EntityColumn<DeptStats>[] = [
    { key: 'department', header: 'Department', render: (r) => r.department_name ?? '—' },
    { key: 'present', header: 'Present', render: (r) => r.present_count ?? 0 },
    { key: 'absent', header: 'Absent', render: (r) => r.absent_count ?? 0 },
    { key: 'total', header: 'Total', render: (r) => r.total_count ?? 0 },
    {
      key: 'rate',
      header: 'Present Rate',
      render: (r) => (
        <span className={`font-medium ${(r.present_rate_pct ?? 0) < 75 ? 'text-status-error' : 'text-status-success'}`}>
          {r.present_rate_pct ?? 0}%
        </span>
      ),
    },
  ];

  return (
    <EntityListPage
      title="Department Attendance"
      columns={columns}
      rows={rows}
      rowKey={(r) => String(r.department_id)}
      searchQuery=""
      onSearchChange={() => {}}
      isSearching={isLoading}
      emptyMessage="No attendance records yet."
      headerActions={
        <button
          onClick={() =>
            downloadCsv(
              'department-attendance-report',
              toCsv(rows, [
                { key: 'department_name', header: 'Department' },
                { key: 'present_count', header: 'Present' },
                { key: 'absent_count', header: 'Absent' },
                { key: 'total_count', header: 'Total' },
                { key: 'present_rate_pct', header: 'Present Rate %' },
              ])
            )
          }
          disabled={rows.length === 0}
          className="px-4 py-2 bg-panel border border-border-default rounded-lg text-sm text-text-secondary hover:text-text-primary hover:border-accent-primary/50 transition-all flex items-center gap-2 disabled:opacity-40"
        >
          <Download size={16} /> Download CSV
        </button>
      }
    />
  );
};

interface DateDeptFilterProps {
  departmentId: string;
  setDepartmentId: (v: string) => void;
  fromDate: string;
  toDate: string;
  setFromDate: (v: string) => void;
  setToDate: (v: string) => void;
  departments: Array<{ id: string; name: string }>;
}

const EntryExitReport: React.FC<DateDeptFilterProps> = ({ departmentId, setDepartmentId, fromDate, toDate, setFromDate, setToDate, departments }) => {
  const { rows, isLoading } = useReportQuery<EntryExitRow>(async () => {
    const { data, error } = await supabase.rpc('report_campus_entry_exit', {
      p_from: fromDate ? new Date(fromDate).toISOString() : undefined,
      p_to: toDate ? new Date(toDate + 'T23:59:59').toISOString() : undefined,
      p_department_id: departmentId || undefined,
    });
    if (error) throw error;
    return data ?? [];
  }, [fromDate, toDate, departmentId]);

  const columns: EntityColumn<EntryExitRow>[] = [
    { key: 'student', header: 'Student', render: (r) => r.full_name ?? r.register_number ?? '—' },
    { key: 'department', header: 'Department', render: (r) => r.department_name ?? '—' },
    { key: 'exit', header: 'Exit Confirmed', render: (r) => new Date(r.exit_confirmed_at).toLocaleString() },
    { key: 'reentry', header: 'Re-entered', render: (r) => (r.re_entered_at ? new Date(r.re_entered_at).toLocaleString() : '—') },
    {
      key: 'state',
      header: 'State',
      render: (r) => (
        <span className="text-xs px-2 py-1 rounded-full font-medium bg-main text-text-muted">
          {r.verification_state.replace(/_/g, ' ')}
        </span>
      ),
    },
  ];

  return (
    <EntityListPage
      title="Campus Entry / Exit"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.event_id}
      searchQuery=""
      onSearchChange={() => {}}
      isSearching={isLoading}
      emptyMessage="No campus exit events in your scope."
      filters={
        <>
          <FilterSelect label="Department" value={departmentId} onChange={setDepartmentId} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
          <div className="min-w-[140px]">
            <label className="text-[10px] text-text-muted uppercase font-bold tracking-wider block mb-1">From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-full bg-main border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary" />
          </div>
          <div className="min-w-[140px]">
            <label className="text-[10px] text-text-muted uppercase font-bold tracking-wider block mb-1">To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-full bg-main border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary" />
          </div>
        </>
      }
      headerActions={
        <button
          onClick={() =>
            downloadCsv(
              'campus-entry-exit-report',
              toCsv(rows, [
                { key: 'full_name', header: 'Student' },
                { key: 'register_number', header: 'Register No' },
                { key: 'department_name', header: 'Department' },
                { key: 'exit_confirmed_at', header: 'Exit Confirmed' },
                { key: 're_entered_at', header: 'Re-entered' },
                { key: 'verification_state', header: 'State' },
              ])
            )
          }
          disabled={rows.length === 0}
          className="px-4 py-2 bg-panel border border-border-default rounded-lg text-sm text-text-secondary hover:text-text-primary hover:border-accent-primary/50 transition-all flex items-center gap-2 disabled:opacity-40"
        >
          <Download size={16} /> Download CSV
        </button>
      }
    />
  );
};

const AuditReport: React.FC<Pick<DateDeptFilterProps, 'fromDate' | 'toDate' | 'setFromDate' | 'setToDate'>> = ({ fromDate, toDate, setFromDate, setToDate }) => {
  const { rows, isLoading } = useReportQuery<AuditRow>(async () => {
    const { data, error } = await supabase.rpc('report_audit_log', {
      p_from: fromDate ? new Date(fromDate).toISOString() : undefined,
      p_to: toDate ? new Date(toDate + 'T23:59:59').toISOString() : undefined,
    });
    if (error) throw error;
    return data ?? [];
  }, [fromDate, toDate]);

  const columns: EntityColumn<AuditRow>[] = [
    { key: 'occurred', header: 'When', render: (r) => new Date(r.occurred_at).toLocaleString() },
    { key: 'action', header: 'Action', render: (r) => r.action },
    { key: 'entity', header: 'Entity', render: (r) => `${r.entity_type}${r.entity_id ? ` #${r.entity_id.slice(0, 8)}` : ''}` },
    { key: 'actor', header: 'Actor Role', render: (r) => r.actor_role ?? '—' },
    { key: 'reason', header: 'Reason', render: (r) => r.reason ?? '—' },
  ];

  return (
    <EntityListPage
      title="Audit Trail"
      columns={columns}
      rows={rows}
      rowKey={(r) => String(r.id)}
      searchQuery=""
      onSearchChange={() => {}}
      isSearching={isLoading}
      emptyMessage="No audit entries in your scope for this window."
      filters={
        <>
          <div className="min-w-[140px]">
            <label className="text-[10px] text-text-muted uppercase font-bold tracking-wider block mb-1">From</label>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-full bg-main border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary" />
          </div>
          <div className="min-w-[140px]">
            <label className="text-[10px] text-text-muted uppercase font-bold tracking-wider block mb-1">To</label>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-full bg-main border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-primary" />
          </div>
        </>
      }
      headerActions={
        <button
          onClick={() =>
            downloadCsv(
              'audit-report',
              toCsv(rows, [
                { key: 'occurred_at', header: 'When' },
                { key: 'action', header: 'Action' },
                { key: 'entity_type', header: 'Entity Type' },
                { key: 'entity_id', header: 'Entity ID' },
                { key: 'actor_role', header: 'Actor Role' },
                { key: 'reason', header: 'Reason' },
              ])
            )
          }
          disabled={rows.length === 0}
          className="px-4 py-2 bg-panel border border-border-default rounded-lg text-sm text-text-secondary hover:text-text-primary hover:border-accent-primary/50 transition-all flex items-center gap-2 disabled:opacity-40"
        >
          <Download size={16} /> Download CSV
        </button>
      }
    />
  );
};

const RoleAssignmentsReport: React.FC<Pick<DateDeptFilterProps, 'departmentId' | 'setDepartmentId' | 'departments'>> = ({ departmentId, setDepartmentId, departments }) => {
  const { rows, isLoading } = useReportQuery<RoleAssignmentRow>(async () => {
    const { data, error } = await supabase.rpc('report_role_assignments', { p_department_id: departmentId || undefined });
    if (error) throw error;
    return data ?? [];
  }, [departmentId]);

  const columns: EntityColumn<RoleAssignmentRow>[] = [
    { key: 'name', header: 'Name', render: (r) => r.full_name ?? '—' },
    { key: 'role', header: 'Role', render: (r) => r.role_key },
    { key: 'department', header: 'Department', render: (r) => r.department_name ?? '—' },
    { key: 'section', header: 'Section', render: (r) => r.section_name ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span className={`text-xs px-2 py-1 rounded-full font-medium ${r.status === 'ACTIVE' ? 'bg-status-success/10 text-status-success' : 'bg-main text-text-muted'}`}>
          {r.status}
        </span>
      ),
    },
  ];

  return (
    <EntityListPage
      title="Role Assignments"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.assignment_id}
      searchQuery=""
      onSearchChange={() => {}}
      isSearching={isLoading}
      emptyMessage="No role assignments in your scope."
      filters={<FilterSelect label="Department" value={departmentId} onChange={setDepartmentId} options={departments.map((d) => ({ value: d.id, label: d.name }))} />}
      headerActions={
        <button
          onClick={() =>
            downloadCsv(
              'role-assignments-report',
              toCsv(rows, [
                { key: 'full_name', header: 'Name' },
                { key: 'role_key', header: 'Role' },
                { key: 'department_name', header: 'Department' },
                { key: 'section_name', header: 'Section' },
                { key: 'status', header: 'Status' },
              ])
            )
          }
          disabled={rows.length === 0}
          className="px-4 py-2 bg-panel border border-border-default rounded-lg text-sm text-text-secondary hover:text-text-primary hover:border-accent-primary/50 transition-all flex items-center gap-2 disabled:opacity-40"
        >
          <Download size={16} /> Download CSV
        </button>
      }
    />
  );
};

export default ReportsPage;
