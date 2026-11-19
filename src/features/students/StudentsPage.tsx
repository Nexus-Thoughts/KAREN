/**
 * Phase 5/6 — Student Management.
 *
 * Ported from reference/IRIS-PAYROLL-main/components/EmployeeList.tsx via
 * EntityListPage: header + scope badge, search toolbar, sticky table, status
 * pills, row actions, pagination — identical markup to IRIS, KAREN content.
 *
 * Scope is entirely RLS-driven (students_select_scoped in
 * supabase/migrations/20260101000700_rls_policies.sql via
 * cims.my_student_ids()): an HOD's query and an ADMIN's query are the exact
 * same PostgREST call — the database decides how many rows come back. The
 * scope badge below is presentational only (it names the caller's own
 * role/department for orientation, the way EmployeeList.tsx flagged
 * "Scoped Access: Engineering & Product" for an HR user) and grants nothing.
 */
import React, { useMemo, useState } from 'react';
import { Plus, Edit2, Eye, CalendarDays } from 'lucide-react';
import { Link } from 'react-router-dom';
import EntityListPage, { type EntityColumn } from '@/components/ui/EntityListPage';
import FilterSelect from '@/components/ui/FilterSelect';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useSupabaseTable } from '@/lib/queries/useSupabaseTable';
import { useLookupOptions } from '@/lib/queries/useLookupOptions';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasPermission, primaryRole } from '@/types/domain';
import type { Database } from '@/types/database';

type Student = Database['public']['Tables']['students']['Row'] & {
  departments: { name: string } | null;
  sections: { name: string; year: number } | null;
  users: { full_name: string; email: string | null } | null;
  mentor: { id: string; employee_id: string; users: { full_name: string } | null } | null;
  class_incharge: { id: string; employee_id: string; users: { full_name: string } | null } | null;
};

const STUDENT_SELECT = `
  *, departments(name), sections(name, year), users(full_name, email),
  mentor:faculty!students_mentor_id_fkey(id, employee_id, users(full_name)),
  class_incharge:faculty!students_class_incharge_id_fkey(id, employee_id, users(full_name))
`;

const statusTone: Record<Student['status'], string> = {
  ACTIVE: 'bg-status-success/10 text-status-success',
  ON_LEAVE: 'bg-status-warning/10 text-status-warning',
  SUSPENDED: 'bg-status-error/10 text-status-error',
  DROPPED: 'bg-status-error/10 text-status-error',
  ALUMNI: 'bg-accent-secondary/10 text-accent-secondary',
};

const emptyForm = {
  register_number: '',
  roll_number: '',
  department_id: '',
  course_id: '',
  section_id: '',
  academic_year_id: '',
  year: 1,
  contact_email: '',
  contact_phone: '',
};

const STATUS_OPTIONS: Student['status'][] = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'DROPPED', 'ALUMNI'];

const StudentsPage: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'students.write');
  const role = profile ? primaryRole(profile) : null;

  const [filterDept, setFilterDept] = useState('');
  const [filterCourse, setFilterCourse] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterYear, setFilterYear] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Server-side filtering (docs' "must remain performant at tens of
  // thousands of students" requirement — nothing here fetches unfiltered
  // rows and narrows them in the browser).
  const activeFilters = useMemo(() => {
    const f: Record<string, string | number> = {};
    if (filterDept) f.department_id = filterDept;
    if (filterCourse) f.course_id = filterCourse;
    if (filterSection) f.section_id = filterSection;
    if (filterYear) f.year = Number(filterYear);
    if (filterStatus) f.status = filterStatus;
    return f;
  }, [filterDept, filterCourse, filterSection, filterYear, filterStatus]);

  const table = useSupabaseTable<'students', Student>('students', {
    select: STUDENT_SELECT,
    searchColumns: ['register_number', 'roll_number'],
    orderBy: { column: 'register_number' },
    pageSize: 50,
    filters: activeFilters,
  });

  const { options: departments } = useLookupOptions('departments', 'id, name', { status: 'ACTIVE' });
  const { options: courses } = useLookupOptions('courses', 'id, name, department_id', { status: 'ACTIVE' });
  const { options: sections } = useLookupOptions('sections', 'id, name, department_id, course_id', { status: 'ACTIVE' });
  const { options: academicYears } = useLookupOptions('academic_years', 'id, label');

  const filterCourseOptions = useMemo(
    () => courses.filter((c) => !filterDept || c.department_id === filterDept),
    [courses, filterDept]
  );
  const filterSectionOptions = useMemo(
    () => sections.filter((s) => !filterCourse || s.course_id === filterCourse),
    [sections, filterCourse]
  );

  const [editing, setEditing] = useState<Student | null>(null);
  const [viewing, setViewing] = useState<Student | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const filteredCourses = useMemo(
    () => courses.filter((c) => !form.department_id || c.department_id === form.department_id),
    [courses, form.department_id]
  );
  const filteredSections = useMemo(
    () => sections.filter((s) => !form.course_id || s.course_id === form.course_id),
    [sections, form.course_id]
  );

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEdit = (student: Student) => {
    setEditing(student);
    setForm({
      register_number: student.register_number,
      roll_number: student.roll_number ?? '',
      department_id: student.department_id,
      course_id: student.course_id,
      section_id: student.section_id ?? '',
      academic_year_id: student.academic_year_id,
      year: student.year,
      contact_email: student.contact_email ?? '',
      contact_phone: student.contact_phone ?? '',
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const payload = {
      register_number: form.register_number,
      roll_number: form.roll_number || null,
      department_id: form.department_id,
      course_id: form.course_id,
      section_id: form.section_id || null,
      academic_year_id: form.academic_year_id,
      year: form.year,
      contact_email: form.contact_email || null,
      contact_phone: form.contact_phone || null,
    };
    const result = editing ? await table.update(editing.id, payload) : await table.insert(payload);
    setSubmitting(false);

    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast(editing ? 'Student updated.' : 'Student enrolled.', 'success');
    setShowModal(false);
  };

  const handleDeactivate = async (student: Student) => {
    if (!window.confirm(`Deactivate ${student.users?.full_name ?? student.register_number}? This can be reversed by an authorised user.`)) return;
    const result = await table.update(student.id, { status: 'DROPPED' });
    if (result.error) showToast(result.error, 'error');
    else showToast('Student marked inactive.', 'warning');
  };

  const columns: EntityColumn<Student>[] = [
    {
      key: 'student',
      header: 'Student',
      render: (s) => (
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-accent-primary/20 flex items-center justify-center text-accent-primary text-xs font-bold shrink-0">
            {(s.users?.full_name ?? s.register_number).charAt(0)}
          </div>
          <div>
            <div className="font-medium text-text-primary text-sm">{s.users?.full_name ?? '(no login yet)'}</div>
            <div className="text-xs text-text-muted">{s.register_number}</div>
          </div>
        </div>
      ),
    },
    { key: 'department', header: 'Department', render: (s) => s.departments?.name ?? '—' },
    { key: 'section', header: 'Section', render: (s) => (s.sections ? `Year ${s.sections.year} - ${s.sections.name}` : '—') },
    { key: 'batch', header: 'Batch', render: (s) => s.batch ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (s) => (
        <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusTone[s.status]}`}>{s.status}</span>
      ),
    },
  ];

  return (
    <>
      <EntityListPage
        title="Students"
        subtitle="Student roster within your authorised scope."
        scopeBadge={role ? `Scope: ${role.replace('_', ' ')}` : undefined}
        columns={columns}
        rows={table.rows}
        rowKey={(s) => s.id}
        searchQuery={table.searchQuery}
        onSearchChange={table.setSearchQuery}
        searchPlaceholder="Search register or roll number..."
        isSearching={table.isSearching}
        emptyMessage={table.error ?? 'No students found in your scope.'}
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
              onChange={(v) => { setFilterDept(v); setFilterCourse(''); setFilterSection(''); }}
              options={departments.map((d) => ({ value: String(d.id), label: String(d.name) }))}
            />
            <FilterSelect
              label="Course"
              value={filterCourse}
              onChange={(v) => { setFilterCourse(v); setFilterSection(''); }}
              options={filterCourseOptions.map((c) => ({ value: String(c.id), label: String(c.name) }))}
            />
            <FilterSelect
              label="Section"
              value={filterSection}
              onChange={setFilterSection}
              options={filterSectionOptions.map((s) => ({ value: String(s.id), label: String(s.name) }))}
            />
            <FilterSelect
              label="Year"
              value={filterYear}
              onChange={setFilterYear}
              options={[1, 2, 3, 4, 5, 6].map((y) => ({ value: String(y), label: `Year ${y}` }))}
            />
            <FilterSelect
              label="Status"
              value={filterStatus}
              onChange={setFilterStatus}
              options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
            />
          </>
        }
        headerActions={
          canWrite && (
            <button
              onClick={openCreate}
              className="flex-1 md:flex-none px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all shadow-lg hover:scale-105 active:scale-95 text-center flex items-center gap-2 justify-center"
            >
              <Plus size={16} /> Enroll Student
            </button>
          )
        }
        rowActions={[
          { label: 'View', icon: Eye, onClick: setViewing },
          ...(canWrite ? [{ label: 'Edit', icon: Edit2, onClick: openEdit }] : []),
        ]}
      />

      {showModal && (
        <Modal title={editing ? 'Edit Student' : 'Enroll Student'} onClose={() => setShowModal(false)} maxWidth="max-w-lg">
          <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Register Number</label>
              <input
                type="text" required
                className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                value={form.register_number}
                onChange={(e) => setForm({ ...form, register_number: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Department</label>
                <select
                  required
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.department_id}
                  onChange={(e) => setForm({ ...form, department_id: e.target.value, course_id: '', section_id: '' })}
                >
                  <option value="">Select...</option>
                  {departments.map((d) => (
                    <option key={String(d.id)} value={String(d.id)}>{String(d.name)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Course</label>
                <select
                  required
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.course_id}
                  onChange={(e) => setForm({ ...form, course_id: e.target.value, section_id: '' })}
                >
                  <option value="">Select...</option>
                  {filteredCourses.map((c) => (
                    <option key={String(c.id)} value={String(c.id)}>{String(c.name)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Section</label>
                <select
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.section_id}
                  onChange={(e) => setForm({ ...form, section_id: e.target.value })}
                >
                  <option value="">Unassigned</option>
                  {filteredSections.map((s) => (
                    <option key={String(s.id)} value={String(s.id)}>{String(s.name)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Year</label>
                <input
                  type="number" min={1} max={8} required
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.year}
                  onChange={(e) => setForm({ ...form, year: Number(e.target.value) })}
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Academic Year</label>
              <select
                required
                className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                value={form.academic_year_id}
                onChange={(e) => setForm({ ...form, academic_year_id: e.target.value })}
              >
                <option value="">Select...</option>
                {academicYears.map((y) => (
                  <option key={String(y.id)} value={String(y.id)}>{String(y.label)}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Contact Email</label>
                <input
                  type="email"
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.contact_email}
                  onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Contact Phone</label>
                <input
                  type="text"
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.contact_phone}
                  onChange={(e) => setForm({ ...form, contact_phone: e.target.value })}
                />
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={submitting} className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50">
                {submitting ? 'Saving...' : editing ? 'Save Changes' : 'Enroll Student'}
              </button>
            </div>
            {canWrite && editing && editing.status !== 'DROPPED' && (
              <button
                type="button"
                onClick={() => handleDeactivate(editing)}
                className="w-full py-2 text-sm text-status-error hover:underline"
              >
                Deactivate this student
              </button>
            )}
          </form>
        </Modal>
      )}

      {viewing && (
        <Modal title={viewing.users?.full_name ?? viewing.register_number} onClose={() => setViewing(null)} maxWidth="max-w-lg">
          <div className="p-6 space-y-5 text-sm max-h-[75vh] overflow-y-auto">
            <div>
              <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Academic Information</h4>
              <div className="space-y-2">
                <Row label="Register No." value={viewing.register_number} />
                <Row label="Roll No." value={viewing.roll_number ?? '—'} />
                <Row label="Department" value={viewing.departments?.name ?? '—'} />
                <Row label="Section" value={viewing.sections ? `Year ${viewing.sections.year} - ${viewing.sections.name}` : '—'} />
                <Row label="Batch" value={viewing.batch ?? '—'} />
                <Row label="Status" value={viewing.status} />
              </div>
            </div>

            <div>
              <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Contact</h4>
              <div className="space-y-2">
                <Row label="Email" value={viewing.contact_email ?? viewing.users?.email ?? '—'} />
                <Row label="Phone" value={viewing.contact_phone ?? '—'} />
              </div>
            </div>

            <div>
              <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Pastoral Assignments</h4>
              <div className="space-y-2">
                <Row label="Mentor" value={viewing.mentor?.users?.full_name ?? 'Unassigned'} />
                <Row label="Class In-charge" value={viewing.class_incharge?.users?.full_name ?? 'Unassigned'} />
              </div>
            </div>

            <div>
              <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Attendance Summary</h4>
              {/* Honest integration point: the attendance engine (Phase 9)
                  does not exist yet, so this is a real "no data" state, not a
                  fabricated percentage — see docs/00 blocker and
                  docs/55 ("no mock production flows"). */}
              <div className="p-4 bg-main rounded-lg border border-border-default border-dashed text-center text-text-muted text-xs">
                Attendance tracking is not yet active for this institution.
              </div>
              <Link
                to={`calendar/${viewing.id}`}
                onClick={() => setViewing(null)}
                className="mt-2 w-full flex items-center justify-center gap-2 py-2 text-xs text-accent-primary hover:underline"
              >
                <CalendarDays size={14} /> Open Student Calendar
              </Link>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between p-3 bg-main rounded-lg border border-border-default">
    <span className="text-text-muted">{label}</span>
    <span className="text-text-primary font-medium">{value}</span>
  </div>
);

export default StudentsPage;
