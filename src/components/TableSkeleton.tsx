interface TableSkeletonProps {
  rows?: number;
  /** Full Tailwind classes per placeholder cell (incl. height), e.g. ['h-4 w-8', 'h-6 w-10']. */
  cells: string[];
  rowHeightClass?: string;
}

/** Shared loading skeleton for catalog/quotes tables (was duplicated per view). */
export function TableSkeleton({ rows = 4, cells, rowHeightClass = 'h-12' }: TableSkeletonProps) {
  return (
    <div className="divide-y divide-slate-100 p-4">
      {Array.from({ length: rows }, (_, n) => (
        <div key={n} className={`flex ${rowHeightClass} items-center gap-4 py-2`}>
          {cells.map((c, i) => (
            <div key={i} className={`${c} animate-pulse rounded bg-slate-200`} />
          ))}
          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-slate-200" />
        </div>
      ))}
    </div>
  );
}
