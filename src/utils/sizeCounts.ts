// The Sizes-column logic lives in the shared module so the Products table and the
// products spreadsheet export (server/) report size counts identically — re-exported
// here for the components that already import it from utils.
export { sizeCountLabel, sizesColumnLines, type MaterialTypeWithSizes } from '../../shared/sizeCounts.ts';
