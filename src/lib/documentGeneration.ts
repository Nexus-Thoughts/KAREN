/**
 * Phase 13 — the client-side half of the document generation pipeline.
 *
 * Drives a `public.documents` row through the real, structurally-enforced
 * lifecycle (supabase/migrations/20260101002200_documents_engine.sql,
 * `cims.validate_document_status_transition` — forward-only, DELIVERED/
 * FAILED terminal) with one UPDATE per stage, so every intermediate state is
 * a real committed row a reader could inspect mid-flight, not a client-side
 * illusion collapsed into a single write.
 *
 * DOCX rendering uses docxtemplater + pizzip entirely in the browser — no
 * server-side renderer exists in this environment (the same class of
 * "real logic, manual/local trigger" limitation as docs/22 ADR-014/019).
 * "The LLM never invents report rows" (docs/10) does not apply to this
 * phase directly (no LLM involved until Phase 14/KAREN) — the merge data
 * below always comes from `public.document_data_student_attendance`, a
 * SECURITY INVOKER function reading real, RLS-scoped rows, never fabricated
 * client-side.
 */
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { supabase } from '@/lib/supabase';
import { toCsv } from '@/lib/csv';
import type { Database } from '@/types/database';

type DocumentStatus = Database['public']['Tables']['documents']['Row']['status'];
type AttendanceData = Database['public']['Functions']['document_data_student_attendance']['Returns'][number];

async function setStatus(documentId: string, status: DocumentStatus, extra?: Record<string, unknown>) {
  const { error } = await supabase.from('documents').update({ status, ...extra }).eq('id', documentId);
  if (error) throw new Error(error.message);
}

async function fail(documentId: string, reason: string): Promise<never> {
  await supabase.from('documents').update({ status: 'FAILED', failed_reason: reason }).eq('id', documentId);
  throw new Error(reason);
}

export interface GenerateResult {
  documentId: string;
  storagePath: string;
}

/**
 * Generates a Student Attendance Certificate for `studentId`, in the
 * requested format. `templateStoragePath` is required only for DOCX (a real
 * .docx template must exist in the document-templates bucket — CSV/JSON
 * need no template, they serialise the same real merge data directly).
 */
export async function generateStudentAttendanceDocument(params: {
  userId: string;
  templateId: string;
  templateStoragePath: string | null;
  studentId: string;
  format: 'DOCX' | 'CSV' | 'JSON';
  fromDate?: string;
  toDate?: string;
}): Promise<GenerateResult> {
  const { userId, templateId, templateStoragePath, studentId, format, fromDate, toDate } = params;

  if (format === 'DOCX' && !templateStoragePath) {
    throw new Error('This template has no stored file — an admin must upload a .docx file for it first.');
  }

  const { data: inserted, error: insertError } = await supabase
    .from('documents')
    .insert({ template_id: templateId, requested_by: userId, entity_type: 'STUDENT', entity_id: studentId, format })
    .select('id')
    .single();
  if (insertError || !inserted) throw new Error(insertError?.message ?? 'Could not create document request');
  const documentId = inserted.id;

  try {
    await setStatus(documentId, 'AUTHORIZED');

    const { data: rows, error: dataError } = await supabase.rpc('document_data_student_attendance', {
      p_student_id: studentId,
      p_from: fromDate ?? undefined,
      p_to: toDate ?? undefined,
    });
    if (dataError) return fail(documentId, `Data fetch failed: ${dataError.message}`);
    const row: AttendanceData | undefined = rows?.[0];
    if (!row) return fail(documentId, 'No attendance data available for this student in the requested range.');

    await setStatus(documentId, 'DATA_FETCHED', { variables: row });

    if (!row.full_name || !row.register_number) {
      return fail(documentId, 'Required merge fields (full_name, register_number) are missing.');
    }
    await setStatus(documentId, 'VALIDATED');

    let blob: Blob;
    let ext: string;
    if (format === 'DOCX') {
      const { data: templateBlob, error: dlError } = await supabase.storage.from('document-templates').download(templateStoragePath!);
      if (dlError || !templateBlob) return fail(documentId, `Template download failed: ${dlError?.message ?? 'not found'}`);
      const zip = new PizZip(await templateBlob.arrayBuffer());
      const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
      try {
        doc.render(row as unknown as Record<string, unknown>);
      } catch (renderError) {
        return fail(documentId, `Template render failed: ${(renderError as Error).message}`);
      }
      blob = doc.getZip().generate({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      ext = 'docx';
    } else if (format === 'CSV') {
      const csv = toCsv([row], Object.keys(row).map((key) => ({ key: key as keyof AttendanceData, header: key })));
      blob = new Blob([csv], { type: 'text/csv' });
      ext = 'csv';
    } else {
      blob = new Blob([JSON.stringify(row, null, 2)], { type: 'application/json' });
      ext = 'json';
    }

    await setStatus(documentId, 'RENDERED');

    const storagePath = `${userId}/${documentId}.${ext}`;
    const { error: uploadError } = await supabase.storage.from('generated-documents').upload(storagePath, blob, { upsert: true });
    if (uploadError) return fail(documentId, `Storage upload failed: ${uploadError.message}`);

    await setStatus(documentId, 'STORED', { storage_path: storagePath });
    await setStatus(documentId, 'DELIVERED');

    return { documentId, storagePath };
  } catch (e) {
    return fail(documentId, (e as Error).message);
  }
}

export async function getDownloadUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from('generated-documents').createSignedUrl(storagePath, 60);
  if (error || !data) throw new Error(error?.message ?? 'Could not create download link');
  return data.signedUrl;
}
