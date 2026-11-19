/**
 * Client-side CSV export for report data. docs/10 names CSV alongside
 * PDF/DOCX/XLSX as a required output format; CSV needs no server-side
 * rendering step, so Phase 12 (Reports) ships it directly — PDF/DOCX/XLSX
 * generation is Phase 13's job (Document Generation), which renders the
 * same real, RLS-scoped data these report views/functions already produce.
 */

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: { key: keyof T & string; header: string }[]): string {
  const headerLine = columns.map((c) => escapeCsvCell(c.header)).join(',');
  const lines = rows.map((row) => columns.map((c) => escapeCsvCell(row[c.key])).join(','));
  return [headerLine, ...lines].join('\r\n');
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
