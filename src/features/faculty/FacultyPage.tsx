/**
 * Phase 5 — Faculty Management.
 *
 * Same EntityListPage/Modal reuse as DepartmentsPage/StudentsPage. A faculty
 * record links to an existing `public.users` row (provisioned via Supabase
 * Auth by an administrator per docs/34 — KAREN never self-registers accounts,
 * `[auth].enable_signup = false` in supabase/config.toml), so creation here
 * is "attach a faculty profile to an existing user account", not "create a
 * login" — that is a separate, not-yet-built User Management screen
 * (tracked under Phase 21 in docs/00_RECONNAISSANCE.md's phase list).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Edit2, Eye } from 'lucide-react';
import EntityListPage, { type EntityColumn } from '@/components/ui/EntityListPage';
import FilterSelect from '@/components/ui/FilterSelect';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useSupabaseTable } from '@/lib/queries/useSupabaseTable';
import { useLookupOptions } from '@/lib/queries/useLookupOptions';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasPermission } from '@/types/domain';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type Faculty = Database['public']['Tables']['faculty']['Row'] & {
  departments: { name: string } | null;
  users: { full_name: string; email: string | null } | null;
};

const FACULTY_SELECT = '*, departments(name), users(full_name, email)';

const emptyForm = { user_id: '', department_id: '', employee_id: '', designation: '' };

const FacultyPage: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'faculty.write');

  const [filterDept, setFilterDept] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const activeFilters = useMemo(() => {
    const f: Record<string, string> = {};
    if (filterDept) f.department_id = filterDept;
    if (filterStatus) f.status = filterStatus;
    return f;
  }, [filterDept, filterStatus]);

  const table = useSupabaseTable<'faculty', Faculty>('faculty', {
    select: FACULTY_SELECT,
    searchColumns: ['employee_id', 'designation'],
    orderBy: { column: 'employee_id' },
    pageSize: 50,
    filters: activeFilters,
  });

  const { options: departments } = useLookupOptions('departments', 'id, name', { status: 'ACTIVE' });
  const { options: users } = useLookupOptions('users', 'id, full_name, email', { status: 'ACTIVE' });

  const [editing, setEditing] = useState<Faculty | null>(null);
  const [viewing, setViewing] = useState<Faculty | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEdit = (f: Faculty) => {
    setEditing(f);
    setForm({ user_id: f.user_id, department_id: f.department_id, employee_id: f.employee_id, designation: f.designation });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = editing
      ? await table.update(editing.id, { department_id: form.department_id, designation: form.designation })
      : await table.insert({
          user_id: form.user_id,
          department_id: form.department_id,
          employee_id: form.employee_id,
          designation: form.designation,
        });
    setSubmitting(false);

    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast(editing ? 'Faculty record updated.' : 'Faculty record created.', 'success');
    setShowModal(false);
  };

  const columns: EntityColumn<Faculty>[] = [
    {
      key: 'faculty',
      header: 'Faculty',
      render: (f) => (
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-accent-secondary/20 flex items-center justify-center text-accent-secondary text-xs font-bold shrink-0">
            {(f.users?.full_name ?? f.employee_id).charAt(0)}
          </div>
          <div>
            <div className="font-medium text-text-primary text-sm">{f.users?.full_name ?? '—'}</div>
            <div className="text-xs text-text-muted">{f.employee_id}</div>
          </div>
        </div>
      ),
    },
    { key: 'department', header: 'Department', render: (f) => f.departments?.name ?? '—' },
    { key: 'designation', header: 'Designation', render: (f) => f.designation },
    {
      key: 'status',
      header: 'Status',
      render: (f) => (
        <span
          className={`text-xs px-2 py-1 rounded-full font-medium ${
            f.status === 'ACTIVE' ? 'bg-status-success/10 text-status-success' : 'bg-status-warning/10 text-status-warning'
          }`}
        >
          {f.status}
        </span>
      ),
    },
  ];

  return (
    <>
      <EntityListPage
        title="Faculty"
        subtitle="Faculty roster within your authorised scope."
        columns={columns}
        rows={table.rows}
        rowKey={(f) => f.id}
        searchQuery={table.searchQuery}
        onSearchChange={table.setSearchQuery}
        searchPlaceholder="Search employee ID or designation..."
        isSearching={table.isSearching}
        emptyMessage={table.error ?? 'No faculty found in your scope.'}
        page={table.page}
        totalPages={table.totalPages}
        totalCount={table.totalCount}
        pageSize={50}
        onNextPage={table.nextPage}
        onPrevPage={table.prevPage}
        filters={
          <>
            <FilterSelect
              label="Department"
              value={filterDept}
              onChange={setFilterDept}
              options={departments.map((d) => ({ value: String(d.id), label: String(d.name) }))}
            />
            <FilterSelect
              label="Status"
              value={filterStatus}
              onChange={setFilterStatus}
              options={[
                { value: 'ACTIVE', label: 'Active' },
                { value: 'INACTIVE', label: 'Inactive' },
                { value: 'ARCHIVED', label: 'Archived' },
              ]}
            />
          </>
        }
        headerActions={
          canWrite && (
            <button
              onClick={openCreate}
              className="flex-1 md:flex-none px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all shadow-lg hover:scale-105 active:scale-95 text-center flex items-center gap-2 justify-center"
            >
              <Plus size={16} /> Add Faculty
            </button>
          )
        }
        rowActions={[
          { label: 'View', icon: Eye, onClick: setViewing },
          ...(canWrite ? [{ label: 'Edit', icon: Edit2, onClick: openEdit }] : []),
        ]}
      />

      {showModal && (
        <Modal title={editing ? 'Edit Faculty' : 'Add Faculty'} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {!editing && (
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">User Account</label>
                <select
                  required
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.user_id}
                  onChange={(e) => setForm({ ...form, user_id: e.target.value })}
                >
                  <option value="">Select an existing account...</option>
                  {users.map((u) => (
                    <option key={String(u.id)} value={String(u.id)}>
                      {String(u.full_name)} ({String(u.email)})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-text-muted mt-1">
                  Accounts are provisioned separately via Supabase Auth; this attaches a faculty profile to one.
                </p>
              </div>
            )}
            {!editing && (
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Employee ID</label>
                <input
                  type="text" required
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  placeholder="e.g. FAC-004"
                  value={form.employee_id}
                  onChange={(e) => setForm({ ...form, employee_id: e.target.value })}
                />
              </div>
            )}
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Department</label>
              <select
                required
                className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                value={form.department_id}
                onChange={(e) => setForm({ ...form, department_id: e.target.value })}
              >
                <option value="">Select...</option>
                {departments.map((d) => (
                  <option key={String(d.id)} value={String(d.id)}>{String(d.name)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Designation</label>
              <input
                type="text" required
                className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                placeholder="e.g. Assistant Professor"
                value={form.designation}
                onChange={(e) => setForm({ ...form, designation: e.target.value })}
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={submitting} className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50">
                {submitting ? 'Saving...' : editing ? 'Save Changes' : 'Add Faculty'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {viewing && <FacultyDetailModal faculty={viewing} onClose={() => setViewing(null)} />}
    </>
  );
};

// ---------------------------------------------------------------------------
// Detail view: subjects/sections taught and pastoral assignment counts.
// A separate small fetch on open, not part of the list query — the list's
// FACULTY_SELECT stays lean (no N+1 join fan-out across every faculty row
// just to populate a detail panel most rows will never open).
// ---------------------------------------------------------------------------
interface AssignmentRow {
  id: string;
  subjects: { code: string; name: string } | null;
  sections: { name: string; year: number } | null;
}

const FacultyDetailModal: React.FC<{ faculty: Faculty; onClose: () => void }> = ({ faculty, onClose }) => {
  const [assignments, setAssignments] = useState<AssignmentRow[] | null>(null);
  const [menteeCount, setMenteeCount] = useState<number | null>(null);
  const [inchargeCount, setInchargeCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    supabase
      .from('faculty_subject_assignments')
      .select('id, subjects(code, name), sections(name, year)')
      .eq('faculty_id', faculty.id)
      .eq('status', 'ACTIVE')
      .then(({ data }) => {
        if (!cancelled) setAssignments((data ?? []) as unknown as AssignmentRow[]);
      });

    supabase
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('mentor_id', faculty.id)
      .then(({ count }) => {
        if (!cancelled) setMenteeCount(count ?? 0);
      });

    supabase
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('class_incharge_id', faculty.id)
      .then(({ count }) => {
        if (!cancelled) setInchargeCount(count ?? 0);
      });

    return () => {
      cancelled = true;
    };
  }, [faculty.id]);

  return (
    <Modal title={faculty.users?.full_name ?? faculty.employee_id} onClose={onClose} maxWidth="max-w-lg">
      <div className="p-6 space-y-5 text-sm max-h-[75vh] overflow-y-auto">
        <div>
          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Profile</h4>
          <div className="space-y-2">
            <Row label="Employee ID" value={faculty.employee_id} />
            <Row label="Department" value={faculty.departments?.name ?? '—'} />
            <Row label="Designation" value={faculty.designation} />
            <Row label="Email" value={faculty.users?.email ?? '—'} />
            <Row label="Status" value={faculty.status} />
          </div>
        </div>

        <div>
          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Subjects &amp; Sections</h4>
          {assignments === null ? (
            <p className="text-xs text-text-muted">Loading…</p>
          ) : assignments.length === 0 ? (
            <div className="p-4 bg-main rounded-lg border border-border-default border-dashed text-center text-text-muted text-xs">
              No active subject assignments.
            </div>
          ) : (
            <div className="space-y-2">
              {assignments.map((a) => (
                <div key={a.id} className="flex items-center justify-between p-3 bg-main rounded-lg border border-border-default">
                  <span className="text-text-primary">{a.subjects?.code} — {a.subjects?.name}</span>
                  <span className="text-text-muted text-xs">
                    {a.sections ? `Year ${a.sections.year} - ${a.sections.name}` : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Pastoral Assignments</h4>
          <div className="space-y-2">
            <Row label="Mentees" value={menteeCount === null ? 'Loading…' : String(menteeCount)} />
            <Row label="Class In-charge for" value={inchargeCount === null ? 'Loading…' : `${inchargeCount} student(s)`} />
          </div>
        </div>
      </div>
    </Modal>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between p-3 bg-main rounded-lg border border-border-default">
    <span className="text-text-muted">{label}</span>
    <span className="text-text-primary font-medium">{value}</span>
  </div>
);

export default FacultyPage;
