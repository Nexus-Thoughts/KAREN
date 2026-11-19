/**
 * Phase 13 — Document Generation.
 *
 * Two tabs, mirroring the GeofencingPage/ReportsPage tab-switcher pattern:
 *   "My Documents" — every role (all hold documents.generate) requests and
 *     downloads real generated documents (RLS-scoped to their own requests
 *     via `documents_select`/`documents_insert`).
 *   "Templates" — admin-only (`document_templates_write` RLS requires
 *     cims.is_admin()) .docx template upload/management, hidden entirely
 *     for a non-admin rather than rendered and disabled.
 */
import React, { useState } from 'react';
import { FileText, Plus, Download, Upload, Loader2 } from 'lucide-react';
import EntityListPage, { type EntityColumn } from '@/components/ui/EntityListPage';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useSupabaseTable } from '@/lib/queries/useSupabaseTable';
import { useLookupOptions } from '@/lib/queries/useLookupOptions';
import { useAuth } from '@/features/auth/AuthProvider';
import { supabase } from '@/lib/supabase';
import { generateStudentAttendanceDocument, getDownloadUrl } from '@/lib/documentGeneration';
import type { Database } from '@/types/database';

type DocumentRow = Database['public']['Tables']['documents']['Row'] & {
  document_templates: { name: string } | null;
};
type TemplateRow = Database['public']['Tables']['document_templates']['Row'];

const STATUS_TONE: Record<string, string> = {
  DELIVERED: 'bg-status-success/10 text-status-success',
  STORED: 'bg-status-success/10 text-status-success',
  FAILED: 'bg-status-error/10 text-status-error',
};

const DocumentsPage: React.FC = () => {
  const { profile } = useAuth();
  const isAdmin = profile?.roles.some((r) => r.role === 'ADMIN') ?? false;
  const [tab, setTab] = useState<'my-documents' | 'templates'>('my-documents');

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h2 className="text-2xl font-bold text-text-primary flex items-center gap-2">
          <FileText size={24} /> Documents
        </h2>
      </div>

      {isAdmin && (
        <div className="flex bg-panel border border-border-default rounded-lg p-1 w-fit">
          {(['my-documents', 'templates'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${tab === t ? 'bg-accent-primary text-white shadow-md' : 'text-text-muted hover:text-text-primary'}`}
            >
              {t === 'my-documents' ? 'My Documents' : 'Templates'}
            </button>
          ))}
        </div>
      )}

      {tab === 'my-documents' ? <MyDocumentsTab /> : <TemplatesTab />}
    </div>
  );
};

const MyDocumentsTab: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const table = useSupabaseTable<'documents', DocumentRow>('documents', {
    select: '*, document_templates(name)',
    orderBy: { column: 'created_at', ascending: false },
    pageSize: 50,
  });
  const { options: templates } = useLookupOptions('document_templates', 'id, name, applies_to, storage_path', { status: 'ACTIVE' });
  const isStaff = profile?.roles.some((r) => r.role !== 'STUDENT') ?? false;
  const { options: students } = useLookupOptions('students', 'id, register_number, users(full_name)');

  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ templateId: '', studentId: profile?.student_id ?? '', format: 'JSON' as 'DOCX' | 'CSV' | 'JSON' });

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    const template = (templates as Array<{ id: string; applies_to: string; storage_path: string }>).find((t) => t.id === form.templateId);
    if (!template) return showToast('Select a template.', 'error');
    const studentId = isStaff ? form.studentId : profile.student_id;
    if (!studentId) return showToast('Select a student.', 'error');

    setSubmitting(true);
    try {
      await generateStudentAttendanceDocument({
        userId: profile.user_id,
        templateId: template.id,
        templateStoragePath: form.format === 'DOCX' ? template.storage_path : null,
        studentId,
        format: form.format,
      });
      showToast('Document generated.', 'success');
      setShowModal(false);
      table.refetch();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownload = async (row: DocumentRow) => {
    if (!row.storage_path) return;
    try {
      const url = await getDownloadUrl(row.storage_path);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  const columns: EntityColumn<DocumentRow>[] = [
    { key: 'template', header: 'Template', render: (r) => r.document_templates?.name ?? '—' },
    { key: 'format', header: 'Format', render: (r) => r.format },
    { key: 'requested', header: 'Requested', render: (r) => new Date(r.created_at).toLocaleString() },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_TONE[r.status] ?? 'bg-main text-text-muted'}`}>
          {r.status}
        </span>
      ),
    },
  ];

  return (
    <>
      <EntityListPage
        title="My Documents"
        columns={columns}
        rows={table.rows}
        rowKey={(r) => r.id}
        searchQuery={table.searchQuery}
        onSearchChange={table.setSearchQuery}
        isSearching={table.isSearching}
        emptyMessage={table.error ?? 'No documents generated yet.'}
        headerActions={
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all shadow-lg flex items-center gap-2"
          >
            <Plus size={16} /> New Document
          </button>
        }
        rowActions={[
          {
            label: 'Download',
            icon: Download,
            onClick: (r) => void handleDownload(r),
            hidden: (r) => r.status !== 'STORED' && r.status !== 'DELIVERED',
          },
        ]}
      />

      {showModal && (
        <Modal title="Generate Document" onClose={() => setShowModal(false)}>
          <form onSubmit={handleGenerate} className="p-6 space-y-4">
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Template</label>
              <select
                required
                className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                value={form.templateId}
                onChange={(e) => setForm({ ...form, templateId: e.target.value })}
              >
                <option value="">Select...</option>
                {templates.map((t) => (
                  <option key={String(t.id)} value={String(t.id)}>
                    {String(t.name)}
                  </option>
                ))}
              </select>
            </div>
            {isStaff && (
              <div>
                <label className="text-xs text-text-muted uppercase font-bold">Student</label>
                <select
                  required
                  className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                  value={form.studentId}
                  onChange={(e) => setForm({ ...form, studentId: e.target.value })}
                >
                  <option value="">Select...</option>
                  {students.map((s) => (
                    <option key={String(s.id)} value={String(s.id)}>
                      {(s.users as { full_name: string } | null)?.full_name ?? String(s.register_number)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Format</label>
              <select
                className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                value={form.format}
                onChange={(e) => setForm({ ...form, format: e.target.value as typeof form.format })}
              >
                <option value="JSON">JSON</option>
                <option value="CSV">CSV</option>
                <option value="DOCX">DOCX</option>
              </select>
            </div>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={submitting} className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2">
                {submitting && <Loader2 size={16} className="animate-spin" />}
                {submitting ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
};

const TemplatesTab: React.FC = () => {
  const { profile } = useAuth();
  const { showToast } = useToast();
  const table = useSupabaseTable<'document_templates', TemplateRow>('document_templates', {
    orderBy: { column: 'created_at', ascending: false },
    pageSize: 50,
  });

  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: '', appliesTo: 'STUDENT_ATTENDANCE_CERTIFICATE', file: null as File | null });

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || !form.file) return showToast('Choose a .docx file.', 'error');
    setSubmitting(true);
    try {
      const path = `templates/${crypto.randomUUID()}-${form.file.name}`;
      const { error: uploadError } = await supabase.storage.from('document-templates').upload(path, form.file);
      if (uploadError) throw new Error(uploadError.message);

      const result = await table.insert({
        name: form.name,
        applies_to: form.appliesTo,
        storage_path: path,
        variable_schema: [
          { key: 'full_name', label: 'Full Name' },
          { key: 'register_number', label: 'Register Number' },
          { key: 'department_name', label: 'Department' },
          { key: 'section_name', label: 'Section' },
          { key: 'present_count', label: 'Present Count' },
          { key: 'absent_count', label: 'Absent Count' },
          { key: 'total_count', label: 'Total Sessions' },
          { key: 'present_rate_pct', label: 'Present Rate %' },
        ],
        created_by: profile.user_id,
      } as never);
      if (result.error) throw new Error(result.error);

      showToast('Template uploaded.', 'success');
      setShowModal(false);
      setForm({ name: '', appliesTo: 'STUDENT_ATTENDANCE_CERTIFICATE', file: null });
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const columns: EntityColumn<TemplateRow>[] = [
    { key: 'name', header: 'Name', render: (r) => r.name },
    { key: 'applies_to', header: 'Applies To', render: (r) => r.applies_to },
    { key: 'status', header: 'Status', render: (r) => r.status },
    { key: 'created', header: 'Created', render: (r) => new Date(r.created_at).toLocaleDateString() },
  ];

  return (
    <>
      <EntityListPage
        title="Document Templates"
        subtitle="Merge fields expected: full_name, register_number, department_name, section_name, present_count, absent_count, total_count, present_rate_pct"
        columns={columns}
        rows={table.rows}
        rowKey={(r) => r.id}
        searchQuery={table.searchQuery}
        onSearchChange={table.setSearchQuery}
        isSearching={table.isSearching}
        emptyMessage={table.error ?? 'No templates uploaded yet.'}
        headerActions={
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 bg-accent-primary text-white rounded-lg hover:bg-accent-secondary transition-all shadow-lg flex items-center gap-2"
          >
            <Upload size={16} /> Upload Template
          </button>
        }
      />

      {showModal && (
        <Modal title="Upload Document Template" onClose={() => setShowModal(false)}>
          <form onSubmit={handleUpload} className="p-6 space-y-4">
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">Name</label>
              <input
                required
                className="w-full mt-1 bg-main border border-border-default rounded-lg p-3 text-text-primary outline-none focus:border-accent-primary"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-text-muted uppercase font-bold">.docx File</label>
              <input
                type="file"
                accept=".docx"
                required
                className="w-full mt-1 text-sm text-text-primary"
                onChange={(e) => setForm({ ...form, file: e.target.files?.[0] ?? null })}
              />
              <p className="text-xs text-text-muted mt-1">
                Use {'{full_name}'}, {'{register_number}'}, {'{department_name}'}, {'{section_name}'}, {'{present_count}'}, {'{absent_count}'}, {'{total_count}'}, {'{present_rate_pct}'} as merge tags.
              </p>
            </div>
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-3 border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={submitting} className="flex-1 py-3 bg-accent-primary text-white rounded-xl hover:bg-accent-secondary transition-colors font-medium disabled:opacity-50">
                {submitting ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
};

export default DocumentsPage;
