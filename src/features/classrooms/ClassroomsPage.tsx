/**
 * Phase 7 — Classroom Management.
 *
 * Same EntityListPage/Modal/FilterSelect reuse as every Phase 5/6 page.
 * `location`/`radius_m` here are the point+radius geofence Phase 9's
 * attendance engine will call ST_DWithin against — see
 * supabase/migrations/20260101001000_timetable_and_classrooms.sql.
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
import ClassroomMapPicker from './ClassroomMapPicker';
import type { Database } from '@/types/database';

type Classroom = Database['public']['Tables']['classrooms']['Row'] & {
  departments: { name: string } | null;
};

const CLASSROOM_SELECT = '*, departments(name)';

const TYPE_LABEL: Record<Classroom['type'], string> = {
  CLASSROOM: 'Classroom',
  LABORATORY: 'Laboratory',
  SEMINAR_HALL: 'Seminar Hall',
  AUDITORIUM: 'Auditorium',
  OTHER: 'Other',
};

const statusTone: Record<Classroom['status'], string> = {
  ACTIVE: 'bg-status-success/10 text-status-success',
  INACTIVE: 'bg-status-warning/10 text-status-warning',
  MAINTENANCE: 'bg-status-error/10 text-status-error',
};

interface FormState {
  department_id: string;
  name: string;
  block: string;
  floor: string;
  capacity: string;
  type: Classroom['type'];
  status: Classroom['status'];
  radius_m: number;
  latitude: number | null;
  longitude: number | null;
}

const emptyForm: FormState = {
  department_id: '',
  name: '',
  block: '',
  floor: '',
  capacity: '',
  type: 'CLASSROOM',
  status: 'ACTIVE',
  radius_m: 20,
  latitude: null,
  longitude: null,
};

const ClassroomsPage: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'classrooms.write');

  const [filterDept, setFilterDept] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const activeFilters = useMemo(() => {
    const f: Record<string, string> = {};
    if (filterDept) f.department_id = filterDept;
    if (filterStatus) f.status = filterStatus;
    return f;
  }, [filterDept, filterStatus]);

  const table = useSupabaseTable<'classrooms', Classroom>('classrooms', {
    select: CLASSROOM_SELECT,
    searchColumns: ['name', 'block'],
    orderBy: { column: 'name' },
    filters: activeFilters,
  });

  const { options: departments } = useLookupOptions('departments', 'id, name', { status: 'ACTIVE' });

  const [editing, setEditing] = useState<Classroom | null>(null);
  const [viewing, setViewing] = useState<Classroom | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEdit = (c: Classroom) => {
    setEditing(c);
    setForm({
      department_id: c.department_id,
      name: c.name,
      block: c.block ?? '',
      floor: c.floor ?? '',
      capacity: c.capacity?.toString() ?? '',
      type: c.type,
      status: c.status,
      radius_m: c.radius_m,
      latitude: c.latitude,
      longitude: c.longitude,
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    const payload: Record<string, unknown> = {
      department_id: form.department_id,
      name: form.name,
      block: form.block || null,
      floor: form.floor || null,
      capacity: form.capacity ? Number(form.capacity) : null,
      type: form.type,
      status: form.status,
      radius_m: form.radius_m,
    };
    // EWKT text — Postgres casts this automatically into the `geography`
    // column; see the migration's own comment on why this, not a
    // client-side WKB encoder.
    if (form.latitude !== null && form.longitude !== null) {
      payload.location = `SRID=4326;POINT(${form.longitude} ${form.latitude})`;
    }

    const result = editing ? await table.update(editing.id, payload as never) : await table.insert(payload as never);
    setSubmitting(false);

    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    showToast(editing ? 'Classroom updated.' : 'Classroom created.', 'success');
    setShowModal(false);
  };

  const columns: EntityColumn<Classroom>[] = [
    {
      key: 'name',
      header: 'Classroom',
      render: (c) => (
        <div>
          <div className="font-medium text-text-primary text-sm">{c.name}</div>
          <div className="text-xs text-text-muted">{[c.block, c.floor && `Floor ${c.floor}`].filter(Boolean).join(' · ')}</div>
        </div>
      ),
    },
    { key: 'department', header: 'Department', render: (c) => c.departments?.name ?? '—' },
    { key: 'type', header: 'Type', render: (c) => TYPE_LABEL[c.type] },
    { key: 'capacity', header: 'Capacity', render: (c) => c.capacity?.toString() ?? '—' },
    {
      key: 'location',
      header: 'Location',
      render: (c) =>
        c.latitude !== null && c.longitude !== null ? (
          <span className="text-xs font-mono text-text-secondary">
            {c.latitude.toFixed(4)}, {c.longitude.toFixed(4)} ({c.radius_m}m)
          </span>
        ) : (
          <span className="text-xs text-status-warning">Not configured</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (c) => <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusTone[c.status]}`}>{c.status}</span>,
    },
  ];

  return (
    <>
      <EntityListPage
        title="Classrooms"
        subtitle="Rooms, coordinates and attendance verification radius."
        columns={columns}
        rows={table.rows}
        rowKey={(c) => c.id}
        searchQuery={table.searchQuery}
        onSearchChange={table.setSearchQuery}
        searchPlaceholder="Search classroom or block..."
        isSearching={table.isSearching}
        emptyMessage={table.error ?? 'No classrooms found in your scope.'}
        page={table.page}
        totalPages={table.totalPages}
        totalCount={table.totalCount}
        pageSize={50}
        onNextPage={table.nextPage}
        onPrevPage={table.prevPage}
        filters={
          <>
            <FilterSelect label="Department" value={filterDept} onChange={setFilterDept} options={departments.map((d) => ({ value: String(d.id), label: String(d.name) }))} />
            <FilterSelect
              label="Status"
              value={filterStatus}
              onChange={setFilterStatus}
              options={[
                { value: 'ACTIVE', label: 'Active' },
                { value: 'INACTIVE', label: 'Inactive' },
                { value: 'MAINTENANCE', label: 'Maintenance' },
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
              <Plus size={16} /> Add Classroom
            </button>
          )
        }
        rowActions={[
          { label: 'View', icon: Eye, onClick: setViewing },
          ...(canWrite ? [{ label: 'Edit', icon: Edit2, onClick: openEdit }] : []),
        ]}
      />

      {showModal && (
        <Modal title={editing ? 'Edit Classroom' : 'Add Classroom'} onClose={() => setShowModal(false)} maxWidth="max-w-2xl">
          <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <div className="grid grid-cols-2 gap-4">
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
                <label className="text-xs text-text-muted uppercase font-bold">Name</label>
                <input
                  type="text" required
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  placeholder="e.g. CS-301"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Block</label>
                <input
                  type="text"
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.block}
                  onChange={(e) => setForm({ ...form, block: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Floor</label>
                <input
                  type="text"
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.floor}
                  onChange={(e) => setForm({ ...form, floor: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Capacity</label>
                <input
                  type="number" min={1}
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.capacity}
                  onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Type</label>
                <select
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as Classroom['type'] })}
                >
                  {Object.entries(TYPE_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Status</label>
                <select
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as Classroom['status'] })}
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                  <option value="MAINTENANCE">Maintenance</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Radius (m)</label>
                <input
                  type="number" min={1} max={500} required
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.radius_m}
                  onChange={(e) => setForm({ ...form, radius_m: Number(e.target.value) })}
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-text-muted uppercase font-bold mb-1 block">Location</label>
              <ClassroomMapPicker
                latitude={form.latitude}
                longitude={form.longitude}
                radiusM={form.radius_m}
                onChange={(lat, lng) => setForm({ ...form, latitude: lat, longitude: lng })}
              />
            </div>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={submitting} className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50">
                {submitting ? 'Saving...' : editing ? 'Save Changes' : 'Create Classroom'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {viewing && <ClassroomDetailModal classroom={viewing} onClose={() => setViewing(null)} />}
    </>
  );
};

// ---------------------------------------------------------------------------
// Detail view: current timetable assignments, lazily fetched only when opened
// ("do not load the entire timetable unnecessarily" — Phase 7 spec).
// ---------------------------------------------------------------------------
interface EntryRow {
  id: string;
  day: string;
  start_time: string;
  end_time: string;
  sections: { name: string; year: number } | null;
  subjects: { code: string; name: string } | null;
}

const ClassroomDetailModal: React.FC<{ classroom: Classroom; onClose: () => void }> = ({ classroom, onClose }) => {
  const [entries, setEntries] = useState<EntryRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('timetable_entries')
      .select('id, day, start_time, end_time, sections(name, year), subjects(code, name)')
      .eq('classroom_id', classroom.id)
      .eq('status', 'ACTIVE')
      .then(({ data }) => {
        if (!cancelled) setEntries((data ?? []) as unknown as EntryRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, [classroom.id]);

  return (
    <Modal title={classroom.name} onClose={onClose} maxWidth="max-w-lg">
      <div className="p-6 space-y-5 text-sm max-h-[75vh] overflow-y-auto">
        <div>
          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Details</h4>
          <div className="space-y-2">
            <Row label="Department" value={classroom.departments?.name ?? '—'} />
            <Row label="Block / Floor" value={[classroom.block, classroom.floor].filter(Boolean).join(' / ') || '—'} />
            <Row label="Type" value={TYPE_LABEL[classroom.type]} />
            <Row label="Capacity" value={classroom.capacity?.toString() ?? '—'} />
            <Row label="Status" value={classroom.status} />
            <Row
              label="Coordinates"
              value={classroom.latitude !== null && classroom.longitude !== null
                ? `${classroom.latitude.toFixed(6)}, ${classroom.longitude.toFixed(6)}`
                : 'Not configured'}
            />
            <Row label="Verification Radius" value={`${classroom.radius_m}m`} />
          </div>
        </div>

        <div>
          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Current Timetable Assignments</h4>
          {entries === null ? (
            <p className="text-xs text-text-muted">Loading…</p>
          ) : entries.length === 0 ? (
            <div className="p-4 bg-main rounded-lg border border-border-default border-dashed text-center text-text-muted text-xs">
              No active timetable assignments for this room.
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((e) => (
                <div key={e.id} className="flex items-center justify-between p-3 bg-main rounded-lg border border-border-default">
                  <span className="text-text-primary">
                    {e.day} {e.start_time.slice(0, 5)}–{e.end_time.slice(0, 5)}
                  </span>
                  <span className="text-text-muted text-xs">
                    {e.subjects?.code} · {e.sections ? `Year ${e.sections.year}-${e.sections.name}` : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
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

export default ClassroomsPage;
