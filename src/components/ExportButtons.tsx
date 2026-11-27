import { FileSpreadsheet, FileText } from 'lucide-react';
import { downloadProtectedFile } from '../utils/api';

interface ExportButtonsProps {
  /** Base URL of the export endpoints, e.g. '/api/colors/export'. */
  baseUrl: string;
  /** Optional query string appended after the format segment, e.g. '?search=...'. */
  query?: string;
  /** Fallback filenames when the server does not send Content-Disposition. */
  fallbackBaseName: string;
  onError: (message: string) => void;
}

const btnClass = 'ui-btn-secondary';

/**
 * Excel/PDF export button pair — shared by the Colors, Products and Issued
 * Quotes views (identical markup in all three).
 */
export function ExportButtons({ baseUrl, query = '', fallbackBaseName, onError }: ExportButtonsProps) {
  const handle = (format: 'excel' | 'pdf') => {
    const ext = format === 'excel' ? 'xlsx' : 'pdf';
    downloadProtectedFile(`${baseUrl}/${format}${query}`, `${fallbackBaseName}.${ext}`).catch((err) =>
      onError(err instanceof Error ? err.message : 'Export failed.')
    );
  };

  return (
    <>
      <button type="button" onClick={() => handle('excel')} className={btnClass}>
        <FileSpreadsheet className="h-3.5 w-3.5 text-[#2a6f3b]" />
        Export Excel
      </button>
      <button type="button" onClick={() => handle('pdf')} className={btnClass}>
        <FileText className="h-3.5 w-3.5 text-[#084091]" />
        Export PDF
      </button>
    </>
  );
}
