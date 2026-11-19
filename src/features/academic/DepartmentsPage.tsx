/**
 * Phase 5 — Departments. First real (non-placeholder) KAREN module.
 *
 * Reuses EntityListPage (ported from reference/IRIS-PAYROLL-main/components/EmployeeList.tsx)
 * and Modal (ported from the Add-Employee dialogs in Dashboard.tsx/EmployeeList.tsx)
 * exactly as those components render for IRIS — only the columns, fields and
 * data source are KAREN-specific (docs/12_UI_UX_SPEC.md, docs/18 Rule 4).
 *
 * All access control is enforced by RLS
 * (supabase/migrations/20260101000700_rls_policies.sql: departments_select /
 * departments_write) — `departments.write` is ADMIN-only per the seeded
 * role_permissions, so a non-admin viewing this page simply has no working
 * create/edit affordance; the page does not re-implement that decision.
 */
import React, { useEffect, useState } from 'react';
import { Plus, Edit2, Eye } from 'lucide-react';
import EntityListPage, { type EntityColumn } from '@/components/ui/EntityListPage';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useSupabaseTable } from '@/lib/queries/useSupabaseTable';
import { useLookupOptions } from '@/lib/queries/useLookupOptions';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasPermission } from '@/types/domain';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

type Department = Database['public']['Tables']['departments']['Row'];

// Deliberately NOT `as const`: that would narrow `status` to the literal
// type 'ACTIVE' from this one object, and useState(emptyForm) would then
// infer the whole form state's status field as that same single-value
// literal type — rejecting any other Department['status'] the edit form
// later tries to assign (e.g. openEdit() copying an INACTIVE department in).
const emptyForm: { code: string; name: string; status: Department['status'] } = {
  code: '',
  name: '',
  status: 'ACTIVE',
};

const DepartmentsPage: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'departments.write');
  // Assigning an HOD is a role-assignment mutation, gated by roles.assign
  // (see user_roles_insert in 20260101000700_rls_policies.sql) — a
  // different capability from departments.write, even though the same ADMIN
  // grant list happens to hold both.
  const canAssignHod = hasPermission(profile, 'roles.assign');

  const table = useSupabaseTable('departments', {
    searchColumns: ['code', 'name'],
    orderBy: { column: 'name' },
    pageSize: 50,
  });

  const [editing, setEditing] = useState<Department | null>(null);
  const [viewing, setViewing] = useState<Department | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEdit = (dept: Department) => {
    setEditing(dept);
    setForm({ code: dept.code, name: dept.name, status: dept.status });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = editing
      ? await table.update(editing.id, { name: form.name, status: form.status })
      : await table.insert({ code: form.code.toUpperCase(), name: form.name, status: form.status });
    setSubmitting(false);

    if (result.error) {
      // Surfaces the real Postgres constraint message (e.g. the unique
      // department code violation) rather than a generic "something went
      // wrong" — docs/50: structured errors, not swallowed ones.
      showToast(result.error, 'error');
      return;
    }
    showToast(editing ? `${form.name} updated.` : `${form.name} created.`, 'success');
    setShowModal(false);
  };

  const columns: EntityColumn<Department>[] = [
    { key: 'code', header: 'Code', render: (d) => <span className="font-mono text-xs text-text-secondary">{d.code}</span> },
    { key: 'name', header: 'Department', render: (d) => <span className="font-medium text-text-primary">{d.name}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (d) => (
        <span
          className={`text-xs px-2 py-1 rounded-full font-medium ${
            d.status === 'ACTIVE' ? 'bg-status-success/10 text-status-success' : 'bg-status-warning/10 text-status-warning'
          }`}
        >
          {d.status}
        </span>
      ),
    },
  ];

  return (
    <>
      <EntityListPage
        title="Departments"
        subtitle="Academic departments across the institution."
        columns={columns}
        rows={table.rows}
        rowKey={(d) => d.id}
        searchQuery={table.searchQuery}
        onSearchChange={table.setSearchQuery}
        searchPlaceholder="Search code or name..."
        isSearching={table.isSearching}
        emptyMessage={table.error ?? 'No departments found.'}
        page={table.page}
        totalPages={table.totalPages}
        totalCount={table.totalCount}
        pageSize={50}
        onNextPage={table.nextPage}
        onPrevPage={table.prevPage}
        headerActions={
          canWrite && (
            <button
              onClick={openCreate}
              className="flex-1 md:flex-none px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all shadow-lg hover:scale-105 active:scale-95 text-center flex items-center gap-2 justify-center"
            >
              <Plus size={16} /> Add Department
            </button>
          )
        }
        rowActions={[
          { label: 'View', icon: Eye, onClick: setViewing },
          ...(canWrite ? [{ label: 'Edit', icon: Edit2, onClick: openEdit }] : []),
        ]}
      />

      {showModal && (
        <Modal title={editing ? 'Edit Department' : 'Add Department'} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Code</label>
              <input
                type="text"
                required
                disabled={!!editing}
                maxLength={16}
                className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary disabled:opacity-50 uppercase"
                placeholder="e.g. CS"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Name</label>
              <input
                type="text"
                required
                className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                placeholder="e.g. Computer Science"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            {editing && (
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Status</label>
                <select
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as Department['status'] })}
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50"
              >
                {submitting ? 'Saving...' : editing ? 'Save Changes' : 'Create Department'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {viewing && <DepartmentDetailModal department={viewing} canAssignHod={canAssignHod} onClose={() => setViewing(null)} />}
    </>
  );
};

// ---------------------------------------------------------------------------
// Detail view: real counts from public.department_stats (a security_invoker
// view — supabase/migrations/20260101000900_department_stats_and_hod.sql —
// so an HOD's counts here are already scoped to what their own RLS reach
// allows, with no extra logic in this component) and the currently assigned
// HOD(s) from public.department_hods.
// ---------------------------------------------------------------------------
interface DeptStats {
  active_course_count: number;
  active_student_count: number;
  active_faculty_count: number;
}
interface HodRow {
  user_id: string;
  full_name: string;
  email: string | null;
}

const DepartmentDetailModal: React.FC<{ department: Department; canAssignHod: boolean; onClose: () => void }> = ({
  department,
  canAssignHod,
  onClose,
}) => {
  const { showToast } = useToast();
  const [stats, setStats] = useState<DeptStats | null>(null);
  const [hods, setHods] = useState<HodRow[] | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [candidateUserId, setCandidateUserId] = useState('');
  const { options: users } = useLookupOptions('users', 'id, full_name, email', { status: 'ACTIVE' });

  const loadHods = () => {
    supabase
      .from('department_hods')
      .select('user_id, full_name, email')
      .eq('department_id', department.id)
      .then(({ data }) => setHods((data ?? []) as HodRow[]));
  };

  useEffect(() => {
    supabase
      .from('department_stats')
      .select('active_course_count, active_student_count, active_faculty_count')
      .eq('department_id', department.id)
      .maybeSingle()
      .then(({ data }) => setStats(data as DeptStats | null));
    loadHods();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department.id]);

  const handleAssignHod = async () => {
    if (!candidateUserId) return;
    setAssigning(true);
    // Resolve the HOD role id, then insert the scoped assignment — mirrors
    // exactly what supabase/seed.sql does for the seeded HOD accounts.
    // Does not deactivate any existing HOD assignment for this department
    // (a department can legitimately have an acting/outgoing overlap); full
    // role-assignment lifecycle management belongs to a dedicated User
    // Management screen, not this stats card.
    const { data: role } = await supabase.from('roles').select('id').eq('key', 'HOD').single();
    if (!role) {
      setAssigning(false);
      showToast('HOD role not found.', 'error');
      return;
    }
    const { error } = await supabase.from('user_roles').insert({
      user_id: candidateUserId,
      role_id: role.id,
      department_id: department.id,
    });
    setAssigning(false);
    if (error) {
      showToast(error.message, 'error');
      return;
    }
    showToast('HOD assigned.', 'success');
    setCandidateUserId('');
    loadHods();
  };

  return (
    <Modal title={department.name} onClose={onClose} maxWidth="max-w-lg">
      <div className="p-6 space-y-5 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Courses" value={stats?.active_course_count} />
          <StatCard label="Students" value={stats?.active_student_count} />
          <StatCard label="Faculty" value={stats?.active_faculty_count} />
        </div>

        <div>
          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Head of Department</h4>
          {hods === null ? (
            <p className="text-xs text-text-muted">Loading…</p>
          ) : hods.length === 0 ? (
            <div className="p-4 bg-main rounded-lg border border-border-default border-dashed text-center text-text-muted text-xs">
              No HOD currently assigned.
            </div>
          ) : (
            <div className="space-y-2">
              {hods.map((h) => (
                <div key={h.user_id} className="flex items-center justify-between p-3 bg-main rounded-lg border border-border-default">
                  <span className="text-text-primary font-medium">{h.full_name}</span>
                  <span className="text-text-muted text-xs">{h.email}</span>
                </div>
              ))}
            </div>
          )}

          {canAssignHod && (
            <div className="flex gap-2 mt-3">
              <select
                className="flex-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary"
                value={candidateUserId}
                onChange={(e) => setCandidateUserId(e.target.value)}
              >
                <option value="">Assign a user as HOD...</option>
                {users.map((u) => (
                  <option key={String(u.id)} value={String(u.id)}>{String(u.full_name)}</option>
                ))}
              </select>
              <button
                onClick={handleAssignHod}
                disabled={!candidateUserId || assigning}
                className="px-4 py-2 bg-accent-primary text-white rounded-lg text-sm hover:bg-accent-secondary disabled:opacity-50"
              >
                {assigning ? 'Assigning…' : 'Assign'}
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

const StatCard: React.FC<{ label: string; value: number | undefined }> = ({ label, value }) => (
  <div className="p-3 bg-main rounded-lg border border-border-default text-center">
    <div className="text-xl font-bold text-text-primary">{value ?? '—'}</div>
    <div className="text-[10px] text-text-muted uppercase tracking-wider mt-1">{label}</div>
  </div>
);

export default DepartmentsPage;
