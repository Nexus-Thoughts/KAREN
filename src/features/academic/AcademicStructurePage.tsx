/**
 * Phase 5 — Courses / Academic Years / Semesters / Subjects / Sections.
 *
 * docs/12_UI_UX_SPEC.md fixes KAREN's top-level navigation (Dashboard,
 * Students, Attendance, Timetable, Classrooms, Geofencing, Notifications,
 * Reports, Documents, AI Assistant, Settings, Audit — no separate nav entry
 * for each academic sub-entity), and docs/18 Rule 6 forbids inventing new
 * visual patterns. Five more top-level nav items would violate both. These
 * five entities are administrative structure that changes rarely and is
 * always browsed together (a course belongs to a department, a section
 * belongs to a course and an academic year), so they live as tabs reached
 * from Departments — one screen, IRIS's existing list/table language per
 * tab, via EntityListPage exactly as every other Phase 5 page uses it.
 */
import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import EntityListPage, { type EntityColumn } from '@/components/ui/EntityListPage';
import FilterSelect from '@/components/ui/FilterSelect';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useSupabaseTable } from '@/lib/queries/useSupabaseTable';
import { useLookupOptions } from '@/lib/queries/useLookupOptions';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasPermission } from '@/types/domain';
import type { Database } from '@/types/database';

type Tab = 'courses' | 'academic_years' | 'semesters' | 'subjects' | 'sections';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'courses', label: 'Courses' },
  { id: 'academic_years', label: 'Academic Years' },
  { id: 'semesters', label: 'Semesters' },
  { id: 'subjects', label: 'Subjects' },
  { id: 'sections', label: 'Sections' },
];

const AcademicStructurePage: React.FC = () => {
  const [tab, setTab] = useState<Tab>('courses');

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h2 className="text-2xl font-bold text-text-primary">Academic Structure</h2>
        <p className="text-text-secondary mt-1">Courses, terms, subjects and sections.</p>
      </div>
      <div className="flex bg-panel border border-border-default rounded-lg p-1 w-fit overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
              tab === t.id ? 'bg-accent-primary text-white shadow-md' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'courses' && <CoursesTab />}
      {tab === 'academic_years' && <AcademicYearsTab />}
      {tab === 'semesters' && <SemestersTab />}
      {tab === 'subjects' && <SubjectsTab />}
      {tab === 'sections' && <SectionsTab />}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------
type Course = Database['public']['Tables']['courses']['Row'] & { departments: { name: string } | null };

const CoursesTab: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'courses.write');
  const [filterDept, setFilterDept] = useState('');
  const table = useSupabaseTable<'courses', Course>('courses', {
    select: '*, departments(name)',
    searchColumns: ['code', 'name'],
    orderBy: { column: 'name' },
    filters: filterDept ? { department_id: filterDept } : {},
  });
  const { options: departments } = useLookupOptions('departments', 'id, name', { status: 'ACTIVE' });

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ department_id: '', code: '', name: '', duration_years: 4 });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = await table.insert({ ...form, code: form.code.toUpperCase() });
    setSubmitting(false);
    if (result.error) return showToast(result.error, 'error');
    showToast('Course created.', 'success');
    setShowModal(false);
    setForm({ department_id: '', code: '', name: '', duration_years: 4 });
  };

  const columns: EntityColumn<Course>[] = [
    { key: 'code', header: 'Code', render: (c) => <span className="font-mono text-xs">{c.code}</span> },
    { key: 'name', header: 'Course', render: (c) => c.name },
    { key: 'department', header: 'Department', render: (c) => c.departments?.name ?? '—' },
    { key: 'duration', header: 'Duration', render: (c) => `${c.duration_years} yrs` },
    { key: 'status', header: 'Status', render: (c) => <StatusPill status={c.status} /> },
  ];

  return (
    <>
      <EntityListPage
        title="Courses" columns={columns} rows={table.rows} rowKey={(c) => c.id}
        searchQuery={table.searchQuery} onSearchChange={table.setSearchQuery}
        isSearching={table.isSearching} emptyMessage={table.error ?? 'No courses found.'}
        filters={<FilterSelect label="Department" value={filterDept} onChange={setFilterDept} options={departments.map((d) => ({ value: String(d.id), label: String(d.name) }))} />}
        headerActions={canWrite && <AddButton label="Add Course" onClick={() => setShowModal(true)} />}
      />
      {showModal && (
        <Modal title="Add Course" onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <SelectField label="Department" value={form.department_id} onChange={(v) => setForm({ ...form, department_id: v })} options={departments} required />
            <TextField label="Code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} placeholder="e.g. BTECH-CS" required />
            <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. B.Tech Computer Science" required />
            <NumberField label="Duration (years)" value={form.duration_years} onChange={(v) => setForm({ ...form, duration_years: v })} min={1} max={8} />
            <FormActions submitting={submitting} onCancel={() => setShowModal(false)} submitLabel="Create Course" />
          </form>
        </Modal>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Academic Years
// ---------------------------------------------------------------------------
type AcademicYear = Database['public']['Tables']['academic_years']['Row'];

const AcademicYearsTab: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'academic_terms.write');
  const table = useSupabaseTable('academic_years', { searchColumns: ['label'], orderBy: { column: 'start_date', ascending: false } });

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ label: '', start_date: '', end_date: '', is_current: false });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = await table.insert(form);
    setSubmitting(false);
    if (result.error) return showToast(result.error, 'error');
    showToast('Academic year created.', 'success');
    setShowModal(false);
    setForm({ label: '', start_date: '', end_date: '', is_current: false });
  };

  const columns: EntityColumn<AcademicYear>[] = [
    { key: 'label', header: 'Academic Year', render: (y) => y.label },
    { key: 'start', header: 'Start', render: (y) => y.start_date },
    { key: 'end', header: 'End', render: (y) => y.end_date },
    { key: 'current', header: 'Current', render: (y) => (y.is_current ? <span className="text-status-success text-xs font-bold">CURRENT</span> : '—') },
  ];

  return (
    <>
      <EntityListPage
        title="Academic Years" columns={columns} rows={table.rows} rowKey={(y) => y.id}
        searchQuery={table.searchQuery} onSearchChange={table.setSearchQuery}
        isSearching={table.isSearching} emptyMessage={table.error ?? 'No academic years found.'}
        headerActions={canWrite && <AddButton label="Add Academic Year" onClick={() => setShowModal(true)} />}
      />
      {showModal && (
        <Modal title="Add Academic Year" onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <TextField label="Label" value={form.label} onChange={(v) => setForm({ ...form, label: v })} placeholder="e.g. 2027-2028" required />
            <div className="grid grid-cols-2 gap-4">
              <DateField label="Start Date" value={form.start_date} onChange={(v) => setForm({ ...form, start_date: v })} required />
              <DateField label="End Date" value={form.end_date} onChange={(v) => setForm({ ...form, end_date: v })} required />
            </div>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input type="checkbox" checked={form.is_current} onChange={(e) => setForm({ ...form, is_current: e.target.checked })} />
              Set as current academic year
            </label>
            {form.is_current && (
              <p className="text-xs text-status-warning">Only one academic year may be current — the database will reject this if another is already marked current.</p>
            )}
            <FormActions submitting={submitting} onCancel={() => setShowModal(false)} submitLabel="Create" />
          </form>
        </Modal>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Semesters
// ---------------------------------------------------------------------------
type Semester = Database['public']['Tables']['semesters']['Row'] & { academic_years: { label: string } | null };

const SemestersTab: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'academic_terms.write');
  const table = useSupabaseTable<'semesters', Semester>('semesters', { select: '*, academic_years(label)', searchColumns: ['label'], orderBy: { column: 'start_date', ascending: false } });
  const { options: years } = useLookupOptions('academic_years', 'id, label');

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ academic_year_id: '', number: 1, label: '', start_date: '', end_date: '', is_current: false });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = await table.insert(form);
    setSubmitting(false);
    if (result.error) return showToast(result.error, 'error');
    showToast('Semester created.', 'success');
    setShowModal(false);
    setForm({ academic_year_id: '', number: 1, label: '', start_date: '', end_date: '', is_current: false });
  };

  const columns: EntityColumn<Semester>[] = [
    { key: 'label', header: 'Semester', render: (s) => s.label },
    { key: 'year', header: 'Academic Year', render: (s) => s.academic_years?.label ?? '—' },
    { key: 'range', header: 'Dates', render: (s) => `${s.start_date} → ${s.end_date}` },
    { key: 'current', header: 'Current', render: (s) => (s.is_current ? <span className="text-status-success text-xs font-bold">CURRENT</span> : '—') },
  ];

  return (
    <>
      <EntityListPage
        title="Semesters" columns={columns} rows={table.rows} rowKey={(s) => s.id}
        searchQuery={table.searchQuery} onSearchChange={table.setSearchQuery}
        isSearching={table.isSearching} emptyMessage={table.error ?? 'No semesters found.'}
        headerActions={canWrite && <AddButton label="Add Semester" onClick={() => setShowModal(true)} />}
      />
      {showModal && (
        <Modal title="Add Semester" onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <SelectField label="Academic Year" value={form.academic_year_id} onChange={(v) => setForm({ ...form, academic_year_id: v })} options={years.map((y) => ({ id: y.id, name: y.label }))} required />
            <div className="grid grid-cols-2 gap-4">
              <NumberField label="Number" value={form.number} onChange={(v) => setForm({ ...form, number: v })} min={1} max={16} />
              <TextField label="Label" value={form.label} onChange={(v) => setForm({ ...form, label: v })} placeholder="e.g. Semester 7" required />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <DateField label="Start Date" value={form.start_date} onChange={(v) => setForm({ ...form, start_date: v })} required />
              <DateField label="End Date" value={form.end_date} onChange={(v) => setForm({ ...form, end_date: v })} required />
            </div>
            <FormActions submitting={submitting} onCancel={() => setShowModal(false)} submitLabel="Create" />
          </form>
        </Modal>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------
type Subject = Database['public']['Tables']['subjects']['Row'] & { departments: { name: string } | null };

const SubjectsTab: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'subjects.write');
  const [filterDept, setFilterDept] = useState('');
  const table = useSupabaseTable<'subjects', Subject>('subjects', {
    select: '*, departments(name)',
    searchColumns: ['code', 'name'],
    orderBy: { column: 'code' },
    filters: filterDept ? { department_id: filterDept } : {},
  });
  const { options: departments } = useLookupOptions('departments', 'id, name', { status: 'ACTIVE' });
  const { options: courses } = useLookupOptions('courses', 'id, name, department_id', { status: 'ACTIVE' });

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ department_id: '', course_id: '', code: '', name: '', credits: 3, semester_number: 1, type: 'THEORY' as Subject['type'] });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = await table.insert({ ...form, code: form.code.toUpperCase(), course_id: form.course_id || null });
    setSubmitting(false);
    if (result.error) return showToast(result.error, 'error');
    showToast('Subject created.', 'success');
    setShowModal(false);
    setForm({ department_id: '', course_id: '', code: '', name: '', credits: 3, semester_number: 1, type: 'THEORY' });
  };

  const columns: EntityColumn<Subject>[] = [
    { key: 'code', header: 'Code', render: (s) => <span className="font-mono text-xs">{s.code}</span> },
    { key: 'name', header: 'Subject', render: (s) => s.name },
    { key: 'department', header: 'Department', render: (s) => s.departments?.name ?? '—' },
    { key: 'credits', header: 'Credits', render: (s) => String(s.credits) },
    { key: 'type', header: 'Type', render: (s) => s.type.replace('_', '/') },
  ];

  return (
    <>
      <EntityListPage
        title="Subjects" columns={columns} rows={table.rows} rowKey={(s) => s.id}
        searchQuery={table.searchQuery} onSearchChange={table.setSearchQuery}
        isSearching={table.isSearching} emptyMessage={table.error ?? 'No subjects found.'}
        filters={<FilterSelect label="Department" value={filterDept} onChange={setFilterDept} options={departments.map((d) => ({ value: String(d.id), label: String(d.name) }))} />}
        headerActions={canWrite && <AddButton label="Add Subject" onClick={() => setShowModal(true)} />}
      />
      {showModal && (
        <Modal title="Add Subject" onClose={() => setShowModal(false)} maxWidth="max-w-lg">
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <SelectField label="Department" value={form.department_id} onChange={(v) => setForm({ ...form, department_id: v, course_id: '' })} options={departments} required />
              <SelectField label="Course" value={form.course_id} onChange={(v) => setForm({ ...form, course_id: v })} options={courses.filter((c) => !form.department_id || c.department_id === form.department_id)} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <TextField label="Code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} placeholder="e.g. CS601" required />
              <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. Machine Learning" required />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <NumberField label="Credits" value={form.credits} onChange={(v) => setForm({ ...form, credits: v })} min={0} max={20} />
              <NumberField label="Semester" value={form.semester_number} onChange={(v) => setForm({ ...form, semester_number: v })} min={1} max={16} />
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Type</label>
                <select className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Subject['type'] })}>
                  <option value="THEORY">Theory</option>
                  <option value="PRACTICAL">Practical</option>
                  <option value="THEORY_PRACTICAL">Theory + Practical</option>
                  <option value="PROJECT">Project</option>
                  <option value="ELECTIVE">Elective</option>
                </select>
              </div>
            </div>
            <FormActions submitting={submitting} onCancel={() => setShowModal(false)} submitLabel="Create Subject" />
          </form>
        </Modal>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
type Section = Database['public']['Tables']['sections']['Row'] & { departments: { name: string } | null; courses: { name: string } | null };

const SectionsTab: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'sections.write');
  const [filterDept, setFilterDept] = useState('');
  const table = useSupabaseTable<'sections', Section>('sections', {
    select: '*, departments(name), courses(name)',
    searchColumns: ['name', 'batch'],
    orderBy: { column: 'name' },
    filters: filterDept ? { department_id: filterDept } : {},
  });
  const { options: departments } = useLookupOptions('departments', 'id, name', { status: 'ACTIVE' });
  const { options: courses } = useLookupOptions('courses', 'id, name, department_id', { status: 'ACTIVE' });
  const { options: years } = useLookupOptions('academic_years', 'id, label');

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ department_id: '', course_id: '', academic_year_id: '', name: '', year: 1, batch: '' });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = await table.insert({ ...form, name: form.name.toUpperCase(), batch: form.batch || null });
    setSubmitting(false);
    if (result.error) return showToast(result.error, 'error');
    showToast('Section created.', 'success');
    setShowModal(false);
    setForm({ department_id: '', course_id: '', academic_year_id: '', name: '', year: 1, batch: '' });
  };

  const columns: EntityColumn<Section>[] = [
    { key: 'name', header: 'Section', render: (s) => `Year ${s.year} - ${s.name}` },
    { key: 'course', header: 'Course', render: (s) => s.courses?.name ?? '—' },
    { key: 'department', header: 'Department', render: (s) => s.departments?.name ?? '—' },
    { key: 'batch', header: 'Batch', render: (s) => s.batch ?? '—' },
    { key: 'count', header: 'Students', align: 'right', render: (s) => String(s.student_count) },
  ];

  return (
    <>
      <EntityListPage
        title="Sections" columns={columns} rows={table.rows} rowKey={(s) => s.id}
        searchQuery={table.searchQuery} onSearchChange={table.setSearchQuery}
        isSearching={table.isSearching} emptyMessage={table.error ?? 'No sections found.'}
        filters={<FilterSelect label="Department" value={filterDept} onChange={setFilterDept} options={departments.map((d) => ({ value: String(d.id), label: String(d.name) }))} />}
        headerActions={canWrite && <AddButton label="Add Section" onClick={() => setShowModal(true)} />}
      />
      {showModal && (
        <Modal title="Add Section" onClose={() => setShowModal(false)} maxWidth="max-w-lg">
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <SelectField label="Department" value={form.department_id} onChange={(v) => setForm({ ...form, department_id: v, course_id: '' })} options={departments} required />
              <SelectField label="Course" value={form.course_id} onChange={(v) => setForm({ ...form, course_id: v })} options={courses.filter((c) => !form.department_id || c.department_id === form.department_id)} required />
            </div>
            <SelectField label="Academic Year" value={form.academic_year_id} onChange={(v) => setForm({ ...form, academic_year_id: v })} options={years.map((y) => ({ id: y.id, name: y.label }))} required />
            <div className="grid grid-cols-3 gap-4">
              <NumberField label="Year" value={form.year} onChange={(v) => setForm({ ...form, year: v })} min={1} max={8} />
              <TextField label="Section" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="e.g. A" required />
              <TextField label="Batch" value={form.batch} onChange={(v) => setForm({ ...form, batch: v })} placeholder="e.g. 2024-2028" />
            </div>
            <FormActions submitting={submitting} onCancel={() => setShowModal(false)} submitLabel="Create Section" />
          </form>
        </Modal>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Shared small field components — kept local to this file since they exist
// only to stop the five tabs above from re-declaring identical <label>/<input>
// markup fragments (the actual reusable primitives, EntityListPage/Modal, are
// the shared components at the components/ui layer).
// ---------------------------------------------------------------------------
const StatusPill: React.FC<{ status: string }> = ({ status }) => (
  <span className={`text-xs px-2 py-1 rounded-full font-medium ${status === 'ACTIVE' ? 'bg-status-success/10 text-status-success' : 'bg-status-warning/10 text-status-warning'}`}>
    {status}
  </span>
);

const AddButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button onClick={onClick} className="flex-1 md:flex-none px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all shadow-lg hover:scale-105 active:scale-95 text-center flex items-center gap-2 justify-center">
    <Plus size={16} /> {label}
  </button>
);

const TextField: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }> = ({ label, value, onChange, placeholder, required }) => (
  <div>
    <label className="text-xs text-text-muted uppercase font-bold">{label}</label>
    <input type="text" required={required} placeholder={placeholder} className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary" value={value} onChange={(e) => onChange(e.target.value)} />
  </div>
);

const DateField: React.FC<{ label: string; value: string; onChange: (v: string) => void; required?: boolean }> = ({ label, value, onChange, required }) => (
  <div>
    <label className="text-xs text-text-muted uppercase font-bold">{label}</label>
    <input type="date" required={required} className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary" value={value} onChange={(e) => onChange(e.target.value)} />
  </div>
);

const NumberField: React.FC<{ label: string; value: number; onChange: (v: number) => void; min?: number; max?: number }> = ({ label, value, onChange, min, max }) => (
  <div>
    <label className="text-xs text-text-muted uppercase font-bold">{label}</label>
    <input type="number" min={min} max={max} className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary" value={value} onChange={(e) => onChange(Number(e.target.value))} />
  </div>
);

const SelectField: React.FC<{ label: string; value: string; onChange: (v: string) => void; options: Array<Record<string, unknown>>; required?: boolean }> = ({ label, value, onChange, options, required }) => (
  <div>
    <label className="text-xs text-text-muted uppercase font-bold">{label}</label>
    <select required={required} className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select...</option>
      {options.map((o) => (
        <option key={String(o.id)} value={String(o.id)}>{String(o.name)}</option>
      ))}
    </select>
  </div>
);

const FormActions: React.FC<{ submitting: boolean; onCancel: () => void; submitLabel: string }> = ({ submitting, onCancel, submitLabel }) => (
  <div className="flex gap-3 pt-2">
    <button type="button" onClick={onCancel} className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors">
      Cancel
    </button>
    <button type="submit" disabled={submitting} className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50">
      {submitting ? 'Saving...' : submitLabel}
    </button>
  </div>
);

export default AcademicStructurePage;
