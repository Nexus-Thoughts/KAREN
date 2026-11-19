/**
 * Phase 8 — Campus + Department/Block Geofencing.
 *
 * Three geofence concepts exist in CIMS and this page only ever shows two of
 * them: CAMPUS (institution-wide, one active at a time) and DEPARTMENT/BLOCK
 * (department-scoped areas). Classroom point+radius geofences (Phase 7) live
 * under Classrooms, not here — see docs/05 on why the three are never merged.
 */
import React, { useMemo, useState } from 'react';
import { Plus, Edit2, Trash2, MapPin, MapPinned } from 'lucide-react';
import EntityListPage, { type EntityColumn } from '@/components/ui/EntityListPage';
import FilterSelect from '@/components/ui/FilterSelect';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useSupabaseTable } from '@/lib/queries/useSupabaseTable';
import { useLookupOptions } from '@/lib/queries/useLookupOptions';
import { useAuth } from '@/features/auth/AuthProvider';
import { hasPermission } from '@/types/domain';
import { supabase } from '@/lib/supabase';
import GeofenceMapEditor from './GeofenceMapEditor';
import EarlyExitPage from '@/features/early-exit/EarlyExitPage';
import type { Database } from '@/types/database';

type Geofence = Database['public']['Tables']['geofences']['Row'];

const TYPE_LABEL: Record<string, string> = { CAMPUS: 'Campus', DEPARTMENT: 'Department', BLOCK: 'Block' };

function parseRing(geojson: string | null): [number, number][] | null {
  if (!geojson) return null;
  try {
    const parsed = JSON.parse(geojson) as { type: string; coordinates: [number, number][][] };
    return parsed.coordinates?.[0] ?? null;
  } catch {
    return null;
  }
}

function ringToEwkt(ring: [number, number][]): string {
  const closed = ring.length > 0 && (ring[0]![0] !== ring[ring.length - 1]![0] || ring[0]![1] !== ring[ring.length - 1]![1])
    ? [...ring, ring[0]!]
    : ring;
  const points = closed.map(([lng, lat]) => `${lng} ${lat}`).join(', ');
  return `SRID=4326;POLYGON((${points}))`;
}

const emptyForm = { type: 'BLOCK' as 'CAMPUS' | 'DEPARTMENT' | 'BLOCK', name: '', department_id: '', ring: null as [number, number][] | null };

const BoundariesTab: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const canWrite = hasPermission(profile, 'geofences.write');
  const isAdmin = profile?.roles.some((r) => r.role === 'ADMIN') ?? false;

  const [filterType, setFilterType] = useState('');
  const [filterDept, setFilterDept] = useState('');
  const activeFilters = useMemo(() => {
    const f: Record<string, string> = {};
    if (filterType) f.type = filterType;
    if (filterDept) f.department_id = filterDept;
    return f;
  }, [filterType, filterDept]);

  const table = useSupabaseTable<'geofences', Geofence>('geofences', {
    searchColumns: ['name'],
    orderBy: { column: 'name' },
    filters: activeFilters,
  });

  const { options: departments } = useLookupOptions('departments', 'id, name', { status: 'ACTIVE' });
  const deptNameById = useMemo(() => new Map(departments.map((d) => [String(d.id), String(d.name)])), [departments]);

  // For the "Current geofence information" panel's "Updated by" field only —
  // best-effort (RLS may not expose every user's name to every viewer, which
  // just falls back to "—" below, same as a missing department already does).
  const { options: userOptions } = useLookupOptions('users', 'id, full_name');
  const userNameById = useMemo(() => new Map(userOptions.map((u) => [String(u.id), String(u.full_name)])), [userOptions]);

  const [editing, setEditing] = useState<Geofence | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const openCreate = (type: typeof emptyForm.type) => {
    setEditing(null);
    setForm({ ...emptyForm, type });
    setShowModal(true);
  };

  const openEdit = async (g: Geofence) => {
    setEditing(g);
    setForm({
      type: g.type as typeof emptyForm.type,
      name: g.name,
      department_id: g.department_id ?? '',
      ring: null, // filled in below once the GeoJSON projection resolves
    });
    setShowModal(true);

    // boundary_geojson lives only on the read-only geofences_geojson view
    // (PostgREST returns the base table's `boundary` as opaque WKB) — fetched
    // lazily here rather than joined into the list query, since the list
    // itself never needs the full polygon, only the edit form does.
    const { data } = await supabase
      .from('geofences_geojson')
      .select('boundary_geojson')
      .eq('id', g.id)
      .single();
    setForm((prev) => ({ ...prev, ring: parseRing(data?.boundary_geojson ?? null) }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.ring || form.ring.length < 3) {
      showToast('Trace a boundary on the map before saving.', 'error');
      return;
    }
    setSubmitting(true);

    const payload = {
      type: form.type,
      name: form.name,
      department_id: form.type === 'CAMPUS' ? null : form.department_id,
      boundary: ringToEwkt(form.ring),
    };

    // geofences_geojson is a read-only view; writes go through the base
    // table directly (its RLS is what actually decides whether this
    // succeeds — the "CAMPUS is admin-only" rule lives there, not here).
    const query = editing
      ? supabase.from('geofences').update(payload).eq('id', editing.id)
      : supabase.from('geofences').insert(payload);
    const { error } = await query;
    setSubmitting(false);

    if (error) {
      showToast(error.message, 'error');
      return;
    }
    showToast(editing ? 'Geofence updated.' : 'Geofence created.', 'success');
    setShowModal(false);
    table.refetch();
  };

  const handleDelete = async (g: Geofence) => {
    if (!window.confirm(`Deactivate the "${g.name}" geofence?`)) return;
    const { error } = await supabase.from('geofences').update({ status: 'INACTIVE' }).eq('id', g.id);
    if (error) showToast(error.message, 'error');
    else {
      showToast('Geofence deactivated.', 'warning');
      table.refetch();
    }
  };

  const columns: EntityColumn<Geofence>[] = [
    { key: 'name', header: 'Name', render: (g) => <span className="font-medium text-text-primary">{g.name}</span> },
    { key: 'type', header: 'Type', render: (g) => TYPE_LABEL[g.type ?? ''] ?? g.type },
    { key: 'department', header: 'Department', render: (g) => (g.department_id ? deptNameById.get(g.department_id) ?? '—' : '—') },
    {
      key: 'status',
      header: 'Status',
      render: (g) => (
        <span className={`text-xs px-2 py-1 rounded-full font-medium ${g.status === 'ACTIVE' ? 'bg-status-success/10 text-status-success' : 'bg-status-warning/10 text-status-warning'}`}>
          {g.status}
        </span>
      ),
    },
  ];

  return (
    <>
      <EntityListPage
        title="Boundaries"
        subtitle="Campus and department/block polygons."
        columns={columns}
        rows={table.rows}
        rowKey={(g) => g.id ?? ''}
        searchQuery={table.searchQuery}
        onSearchChange={table.setSearchQuery}
        searchPlaceholder="Search geofence name..."
        isSearching={table.isSearching}
        emptyMessage={table.error ?? 'No geofences configured yet.'}
        filters={
          <>
            <FilterSelect label="Type" value={filterType} onChange={setFilterType} options={[{ value: 'CAMPUS', label: 'Campus' }, { value: 'DEPARTMENT', label: 'Department' }, { value: 'BLOCK', label: 'Block' }]} />
            <FilterSelect label="Department" value={filterDept} onChange={setFilterDept} options={departments.map((d) => ({ value: String(d.id), label: String(d.name) }))} />
          </>
        }
        headerActions={
          canWrite && (
            <div className="flex gap-2">
              {isAdmin && (
                <button onClick={() => openCreate('CAMPUS')} className="px-4 py-2 bg-panel border border-border-default rounded-lg text-text-secondary hover:text-text-primary transition-colors flex items-center gap-2">
                  <MapPin size={16} /> Campus Boundary
                </button>
              )}
              <button onClick={() => openCreate('BLOCK')} className="px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all shadow-lg flex items-center gap-2">
                <Plus size={16} /> Add Area
              </button>
            </div>
          )
        }
        rowActions={
          canWrite
            ? [
                { label: 'Edit', icon: Edit2, onClick: openEdit },
                { label: 'Deactivate', icon: Trash2, onClick: handleDelete, tone: 'danger', hidden: (g) => g.status !== 'ACTIVE' },
              ]
            : []
        }
      />

      {showModal && (
        <Modal title={editing ? `Edit ${TYPE_LABEL[form.type]}` : `Add ${TYPE_LABEL[form.type]}`} onClose={() => setShowModal(false)} maxWidth="max-w-2xl">
          <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Name</label>
                <input
                  type="text" required
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  placeholder={form.type === 'CAMPUS' ? 'e.g. Main Campus' : 'e.g. CS Block A'}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              {form.type !== 'CAMPUS' && (
                <div>
                  <label className="text-xs text-text-muted uppercase font-bold">Department</label>
                  <select
                    required
                    className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                    value={form.department_id}
                    onChange={(e) => setForm({ ...form, department_id: e.target.value })}
                  >
                    <option value="">Select...</option>
                    {departments.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.name)}</option>)}
                  </select>
                </div>
              )}
            </div>

            {!editing && (
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Area type</label>
                <div className="flex gap-2 mt-1">
                  {(['DEPARTMENT', 'BLOCK'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setForm({ ...form, type: t })}
                      className={`px-3 py-1.5 rounded-lg text-sm border ${form.type === t ? 'bg-accent-primary text-white border-accent-primary' : 'border-border-default text-text-secondary'}`}
                    >
                      {TYPE_LABEL[t]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <GeofenceMapEditor
              polygon={form.ring}
              onChange={(ring) => setForm({ ...form, ring })}
              info={
                editing
                  ? {
                      status: editing.status ?? 'ACTIVE',
                      updatedAt: editing.updated_at ?? null,
                      updatedByName: editing.updated_by ? userNameById.get(editing.updated_by) ?? null : null,
                    }
                  : undefined
              }
            />

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
              <button type="submit" disabled={submitting} className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50">
                {submitting ? 'Saving...' : editing ? 'Save Changes' : 'Create Geofence'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Top-level Geofencing module. docs/12's navigation list is fixed and has no
// separate "Early Exit" entry, the same constraint Student Calendar runs
// into — early-exit monitoring is fundamentally a campus-presence concern
// (docs/05), so it lives as a second tab here rather than a route with
// nowhere in the fixed nav to link from (mirrors the tab pattern
// AcademicStructurePage already established for a similar "no room in the
// fixed nav" situation).
// ---------------------------------------------------------------------------
// GeofencingWorkflow — purpose banner + visual verification flow diagram.
// Pure HTML/CSS — no external library required.
// ---------------------------------------------------------------------------
const GeofencingWorkflow: React.FC = () => (
  <div className="bg-panel border border-border-default rounded-xl overflow-hidden">
    {/* Purpose banner */}
    <div className="p-5 border-b border-border-default bg-gradient-to-r from-accent-primary/10 to-transparent">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-accent-primary/20 flex items-center justify-center flex-shrink-0">
          <MapPinned size={20} className="text-accent-primary" />
        </div>
        <div>
          <h3 className="font-semibold text-text-primary">What is Geo-Fencing?</h3>
          <p className="text-sm text-text-secondary mt-1">
            Geo-Fencing verifies that attendance is being marked from an approved physical
            location. When a student or faculty member marks attendance, the system checks
            their GPS coordinates against the configured campus or classroom boundary.
            If they are outside the allowed radius, attendance is rejected and an alert is raised.
          </p>
        </div>
      </div>
    </div>

    {/* Workflow diagram */}
    <div className="p-5">
      <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-4">Verification Workflow</p>
      <div className="flex flex-col sm:flex-row items-center gap-2 flex-wrap">
        {[
          { label: 'Attendance Attempt', desc: 'Student / Faculty submits attendance', color: 'bg-accent-primary/10 border-accent-primary/30 text-accent-primary' },
          null, // arrow
          { label: 'Location Obtained', desc: 'Device GPS coordinates captured', color: 'bg-status-info/10 border-status-info/30 text-status-info' },
          null,
          { label: 'Geo-Fence Check', desc: 'Distance compared to allowed radius', color: 'bg-status-warning/10 border-status-warning/30 text-status-warning' },
        ].map((step, i) =>
          step === null ? (
            <div key={i} className="text-text-muted hidden sm:block">→</div>
          ) : (
            <div key={i} className={`flex-1 min-w-[140px] p-3 rounded-xl border ${step.color}`}>
              <p className="text-xs font-semibold">{step.label}</p>
              <p className="text-[10px] mt-0.5 opacity-80">{step.desc}</p>
            </div>
          )
        )}
      </div>

      {/* Result split */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="p-3 rounded-xl border border-status-success/30 bg-status-success/5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-status-success text-sm font-bold">✓</span>
            <p className="text-xs font-semibold text-status-success">Inside Radius</p>
          </div>
          <p className="text-[11px] text-text-muted">Attendance allowed and recorded as Present. Audit record created.</p>
        </div>
        <div className="p-3 rounded-xl border border-status-error/30 bg-status-error/5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-status-error text-sm font-bold">✗</span>
            <p className="text-xs font-semibold text-status-error">Outside Radius</p>
          </div>
          <p className="text-[11px] text-text-muted">Attendance rejected or flagged as OUTSIDE_CAMPUS. Audit record created. Admin notified if configured.</p>
        </div>
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
const GeofencingPage: React.FC = () => {
  const [tab, setTab] = useState<'boundaries' | 'early-exit'>('boundaries');

  return (
    <div className="space-y-5 animate-in fade-in duration-500">
      <div>
        <h2 className="text-2xl font-bold text-text-primary flex items-center gap-2">
          <MapPinned size={22} className="text-accent-primary" />
          Geo-Fencing
        </h2>
        <p className="text-text-secondary mt-1">
          Location-based attendance verification, campus boundaries, and early-exit monitoring.
        </p>
      </div>

      {/* Purpose + workflow */}
      <GeofencingWorkflow />

      {/* Existing tabs */}
      <div className="flex bg-panel border border-border-default rounded-lg p-1 w-fit">
        {([
          { id: 'boundaries', label: 'Boundary Management' },
          { id: 'early-exit', label: 'Early Exit Monitoring' },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${tab === t.id ? 'bg-accent-primary text-white shadow-md' : 'text-text-muted hover:text-text-primary'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'boundaries' ? <BoundariesTab /> : <EarlyExitPage />}
    </div>
  );
};

export default GeofencingPage;
