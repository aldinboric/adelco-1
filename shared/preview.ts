// A Product with no Material Types is a Preview: saved for completion later, visibly
// incomplete, and impossible to sell. It is derived from the Material Types and never
// stored, so saving the first one promotes the Product and deleting the last one
// demotes it, with no separate promotion step.

/** The Material Types a Product defines, however they are held. */
type MaterialTypes = readonly unknown[] | null | undefined;

/** Where a Product stands: its completeness first, then its stock state. */
export type ProductStatus = 'preview' | 'available' | 'unavailable';

/** A Product is a Preview exactly while it has no Material Types. */
export function isPreview(materialTypes: MaterialTypes): boolean {
  return (materialTypes?.length ?? 0) === 0;
}

/** A Preview outranks Available/Unavailable: the more urgent state is the one shown. */
export function productStatus(materialTypes: MaterialTypes, isAvailable: boolean): ProductStatus {
  if (isPreview(materialTypes)) return 'preview';
  return isAvailable ? 'available' : 'unavailable';
}

/** The word the Products table's Status column shows. */
export function productStatusLabel(status: ProductStatus): string {
  switch (status) {
    case 'preview':
      return 'Preview';
    case 'unavailable':
      return 'Unavailable';
    case 'available':
      return 'Available';
  }
}
