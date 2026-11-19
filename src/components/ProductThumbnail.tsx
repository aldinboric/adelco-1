import { Layers } from 'lucide-react';
import { useState } from 'react';
import { getImageUrl } from '../utils/format';

interface ProductThumbnailProps {
  imagePath: string | null | undefined;
  alt: string;
  sizeClass?: string;
}

export function ProductThumbnail({
  imagePath,
  alt,
  sizeClass = 'h-10 w-10',
}: ProductThumbnailProps) {
  const [failed, setFailed] = useState(false);
  const url = getImageUrl(imagePath);

  if (!url || failed) {
    return (
      <div
        className={`${sizeClass} flex shrink-0 items-center justify-center rounded bg-[#f7f7f7] text-slate-400`}
        aria-label={alt}
      >
        <Layers className="h-4 w-4" />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${sizeClass} shrink-0 rounded bg-[#f7f7f7] object-contain p-0.5`}
    />
  );
}
