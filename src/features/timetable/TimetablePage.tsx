/**
 * Phase 7 — Timetable.
 *
 * A weekly grid (Mon–Sat columns), not another EntityListPage table — the
 * IRIS source has no direct precedent for a schedule grid, so this composes
 * from IRIS's existing card/badge/modal language per docs/18 Rule 5 ("for
 * KAREN-specific workflows... reuse IRIS controls around it, preserve IRIS
 * spacing/typography/states") rather than inventing a table-shaped view of
 * what is fundamentally a 2D schedule.
 *
 * Scope is entirely RLS-driven via cims.my_section_ids() (docs/22, the RLS
 * migration's own header comment) — a student/faculty/HOD/admin all issue
 * the exact same query; the database decides what comes back. The filters
 * below narrow within that same set, they do not grant additional reach.
 */
import React, { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import FilterSelect from '@/components/ui/FilterSelect';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useSupabaseTable } from '@/lib/queries/useSupabaseTable';
import { useLookupOptions } from '@/lib/queries/useLookupOptions';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasPermission } from '@/types/domain';
import type { Database } from '@/types/database';

type Entry = Database['public']['Tables']['timetable_entries']['Row'] & {
  sections: { name: string; year: number; department_id: string } | null;
  subjects: { code: string; name: string } | null;
  faculty: { employee_id: string; users: { full_name: string } | null } | null;
  classrooms: { name: string } | null;
};

const ENTRY_SELECT = `
  *, sections(name, year, department_id), subjects(code, name),
  faculty(employee_id, users(full_name)), classrooms(name)
`;

const DAYS: Entry['day'][] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DAY_LABEL: Record<Entry['day'], string> = {
  MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday',
};

const emptyForm = {
  academic_year_id: '', semester_id: '', section_id: '', subject_id: '',
  faculty_id: '', classroom_id: '', day: 'MON' as Entry['day'], start_time: '09:00', end_time: '09:50',
};

const TimetablePage: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'timetable.write');

  const [filterDept, setFilterDept] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterFaculty, setFilterFaculty] = useState('');
  const [filterClassroom, setFilterClassroom] = useState('');

  const activeFilters = useMemo(() => {
    const f: Record<string, string> = {};
    if (filterSection) f.section_id = filterSection;
    if (filterFaculty) f.faculty_id = filterFaculty;
    if (filterClassroom) f.classroom_id = filterClassroom;
    return f;
  }, [filterSection, filterFaculty, filterClassroom]);

  const table = useSupabaseTable<'timetable_entries', Entry>('timetable_entries', {
    select: ENTRY_SELECT,
    orderBy: { column: 'start_time' },
    pageSize: 500, // a weekly grid needs the whole reachable set, not one page of 50
    filters: { ...activeFilters, status: 'ACTIVE' },
  });

  const { options: departments } = useLookupOptions('departments', 'id, name', { status: 'ACTIVE' });
  const { options: sections } = useLookupOptions('sections', 'id, name, year, department_id', { status: 'ACTIVE' });
  const { options: facultyList } = useLookupOptions('faculty', 'id, employee_id, department_id, users(full_name)', { status: 'ACTIVE' });
  const { options: classrooms } = useLookupOptions('classrooms', 'id, name, department_id', { status: 'ACTIVE' });
  const { options: subjects } = useLookupOptions('subjects', 'id, code, name, department_id', { status: 'ACTIVE' });
  const { options: academicYears } = useLookupOptions('academic_years', 'id, label');
  const { options: semesters } = useLookupOptions('semesters', 'id, label, academic_year_id');

  const visibleSections = useMemo(
    () => sections.filter((s) => !filterDept || s.department_id === filterDept),
    [sections, filterDept]
  );

  const rowsByDay = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const day of DAYS) map.set(day, []);
    for (const entry of table.rows) {
      map.get(entry.day)?.push(entry);
    }
    return map;
  }, [table.rows]);

  const [showModal, setShowModal] = useState(false);
  const [viewing, setViewing] = useState<Entry | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const result = await table.insert(form as never);
    setSubmitting(false);
    if (result.error) {
      // Surfaces the real Postgres conflict message (EXCLUDE constraint
      // violations, invalid-time, academic-relationship rejection) — the
      // whole point of enforcing these in the database rather than only in
      // React is that this message is authoritative, not a guess.
      showToast(result.error, 'error');
      return;
    }
    showToast('Timetable entry created.', 'success');
    setShowModal(false);
    setForm(emptyForm);
  };

  const handleDelete = async (entry: Entry) => {
    if (!window.confirm('Remove this timetable entry?')) return;
    const result = await table.update(entry.id, { status: 'INACTIVE' } as never);
    if (result.error) showToast(result.error, 'error');
    else {
      showToast('Timetable entry removed.', 'warning');
      setViewing(null);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h2 className="text-2xl font-bold text-text-primary">Timetable</h2>
          <p className="text-text-secondary mt-1">Weekly schedule within your authorised scope.</p>
        </div>
        {canWrite && (
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all shadow-lg hover:scale-105 active:scale-95 flex items-center gap-2"
          >
            <Plus size={16} /> Add Entry
          </button>
        )}
      </div>

      <div className="bg-panel border border-border-default rounded-xl p-4 flex flex-wrap gap-3">
        <FilterSelect label="Department" value={filterDept} onChange={(v) => { setFilterDept(v); setFilterSection(''); }} options={departments.map((d) => ({ value: String(d.id), label: String(d.name) }))} />
        <FilterSelect label="Section" value={filterSection} onChange={setFilterSection} options={visibleSections.map((s) => ({ value: String(s.id), label: `Year ${s.year} - ${s.name}` }))} />
        <FilterSelect label="Faculty" value={filterFaculty} onChange={setFilterFaculty} options={facultyList.map((f) => ({ value: String(f.id), label: (f.users as { full_name: string } | null)?.full_name ?? String(f.employee_id) }))} />
        <FilterSelect label="Classroom" value={filterClassroom} onChange={setFilterClassroom} options={classrooms.map((c) => ({ value: String(c.id), label: String(c.name) }))} />
      </div>

      {table.isLoading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : table.error ? (
        <p className="text-sm text-status-error">{table.error}</p>
      ) : table.rows.length === 0 ? (
        <div className="p-12 bg-panel border border-border-default rounded-xl text-center text-text-muted text-sm">
          No timetable entries found in your scope.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {DAYS.map((day) => {
            const entries = (rowsByDay.get(day) ?? []).slice().sort((a, b) => a.start_time.localeCompare(b.start_time));
            return (
              <div key={day} className="bg-panel border border-border-default rounded-xl overflow-hidden">
                <div className="p-3 bg-main/50 border-b border-border-default">
                  <h3 className="text-sm font-bold text-text-primary">{DAY_LABEL[day]}</h3>
                </div>
                <div className="divide-y divide-border-default">
                  {entries.length === 0 ? (
                    <p className="p-4 text-xs text-text-muted text-center">No classes.</p>
                  ) : (
                    entries.map((entry) => (
                      <button
                        key={entry.id}
                        onClick={() => setViewing(entry)}
                        className="w-full text-left p-3 hover:bg-main/50 transition-colors"
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <div className="text-sm font-medium text-text-primary">{entry.subjects?.code} — {entry.subjects?.name}</div>
                            <div className="text-xs text-text-muted mt-0.5">
                              {entry.faculty?.users?.full_name ?? entry.faculty?.employee_id} · {entry.classrooms?.name}
                              {entry.sections && ` · Year ${entry.sections.year}-${entry.sections.name}`}
                            </div>
                          </div>
                          <span className="text-xs font-mono text-accent-secondary whitespace-nowrap">
                            {entry.start_time.slice(0, 5)}–{entry.end_time.slice(0, 5)}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewing && (
        <Modal title={`${viewing.subjects?.code ?? ''} — ${DAY_LABEL[viewing.day]}`} onClose={() => setViewing(null)}>
          <div className="p-6 space-y-3 text-sm">
            <Row label="Subject" value={viewing.subjects?.name ?? '—'} />
            <Row label="Section" value={viewing.sections ? `Year ${viewing.sections.year} - ${viewing.sections.name}` : '—'} />
            <Row label="Faculty" value={viewing.faculty?.users?.full_name ?? viewing.faculty?.employee_id ?? '—'} />
            <Row label="Classroom" value={viewing.classrooms?.name ?? '—'} />
            <Row label="Time" value={`${viewing.start_time.slice(0, 5)} – ${viewing.end_time.slice(0, 5)}`} />
            {canWrite && (
              <button
                onClick={() => handleDelete(viewing)}
                className="w-full py-2 mt-2 text-sm text-status-error hover:underline flex items-center justify-center gap-1"
              >
                <X size={14} /> Remove this entry
              </button>
            )}
          </div>
        </Modal>
      )}

      {showModal && (
        <Modal title="Add Timetable Entry" onClose={() => setShowModal(false)} maxWidth="max-w-lg">
          <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Academic Year</label>
                <select required className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary" value={form.academic_year_id} onChange={(e) => setForm({ ...form, academic_year_id: e.target.value, semester_id: '' })}>
                  <option value="">Select...</option>
                  {academicYears.map((y) => <option key={String(y.id)} value={String(y.id)}>{String(y.label)}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Semester</label>
                <select required className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary" value={form.semester_id} onChange={(e) => setForm({ ...form, semester_id: e.target.value })}>
                  <option value="">Select...</option>
                  {semesters.filter((s) => !form.academic_year_id || s.academic_year_id === form.academic_year_id).map((s) => <option key={String(s.id)} value={String(s.id)}>{String(s.label)}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Section</label>
              <select required className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary" value={form.section_id} onChange={(e) => setForm({ ...form, section_id: e.target.value })}>
                <option value="">Select...</option>
                {sections.map((s) => <option key={String(s.id)} value={String(s.id)}>{`Year ${s.year} - ${s.name}`}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Subject</label>
                <select required className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary" value={form.subject_id} onChange={(e) => setForm({ ...form, subject_id: e.target.value })}>
                  <option value="">Select...</option>
                  {subjects.map((s) => <option key={String(s.id)} value={String(s.id)}>{String(s.code)}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Faculty</label>
                <select required className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary" value={form.faculty_id} onChange={(e) => setForm({ ...form, faculty_id: e.target.value })}>
                  <option value="">Select...</option>
                  {facultyList.map((f) => <option key={String(f.id)} value={String(f.id)}>{(f.users as { full_name: string } | null)?.full_name ?? String(f.employee_id)}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Classroom</label>
              <select required className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary" value={form.classroom_id} onChange={(e) => setForm({ ...form, classroom_id: e.target.value })}>
                <option value="">Select...</option>
                {classrooms.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.name)}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Day</label>
                <select className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary" value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value as Entry['day'] })}>
                  {DAYS.map((d) => <option key={d} value={d}>{DAY_LABEL[d]}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Start</label>
                <input type="time" required className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} />
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">End</label>
                <input type="time" required className="w-full mt-1 bg-main border border-border-default rounded-lg p-2 text-sm text-text-primary outline-none focus:border-accent-primary" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} />
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
              <button type="submit" disabled={submitting} className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50">
                {submitting ? 'Saving...' : 'Create Entry'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between p-3 bg-main rounded-lg border border-border-default">
    <span className="text-text-muted">{label}</span>
    <span className="text-text-primary font-medium">{value}</span>
  </div>
);

export default TimetablePage;
