export type AppTab = 'quote' | 'issued' | 'products' | 'colors' | 'admin';

// Role & permission types come from the shared module (single source of truth with the backend).
import type { UserPermissions, UserRole } from '../shared/permissions.ts';
import type { CopiedSizeResolution } from '../shared/size.ts';
export type { PermissionKey, UserPermissions, UserRole } from '../shared/permissions.ts';

export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  permissions: UserPermissions;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface MetalColor {
  id: number;
  name: string;
  hex_code: string;
  price_per_lf_cents: number;
  is_available: number;
  sort_order: number;
  created_at: string;
}

export interface ProductMaterialSize {
  id: number;
  material_id: number;
  price_per_lf_cents: number;
  width_in: number | null;
  gauge: string | null;
  length_ft: number | null;
  sort_order: number;
  created_at: string;
}

export interface ProductMaterial {
  id: number;
  product_id: number;
  name: string;
  price_per_lf_cents: number;
  /** Legacy Dimension columns: kept for rows written before Sizes existed. */
  width_in: number | null;
  gauge: string | null;
  length_ft: number | null;
  sort_order: number;
  created_at: string;
  sizes: ProductMaterialSize[];
}

export interface MetalProduct {
  id: number;
  name: string;
  image_path: string | null;
  material_type: string | null;
  price_per_lf_cents: number;
  is_available: number;
  sort_order: number;
  created_at: string;
  materials: ProductMaterial[];
}

/** The editable fields of one Size row in the catalog editor and the in-quote add-size form. */
export interface SizeFormInput {
  price: string;
  width: string;
  gauge: string;
  length: string;
}

export interface QuoteDraftItem {
  rowKey: string;
  product_id: number | null;
  material_type: string;
  /** The row's Size selection and any resolution flag, as one object (shared with the server's copy). */
  sizeResolution: CopiedSizeResolution;
  color_id: number | null;
  linear_feet_input: string;
  additional_costs_input: string;
  additional_costs_description: string;
  note_input: string;
  productIssue?: 'unavailable' | 'deleted' | null;
  colorIssue?: 'unavailable' | 'deleted' | null;
  fallbackProductName?: string;
  fallbackColorName?: string;
  fallbackColorHex?: string;
}

export interface QuoteDraftState {
  customer_name: string;
  seller_name: string;
  quote_date: string;
  items: QuoteDraftItem[];
  copiedFromQuoteNumber?: string | null;
}

/** Payload item sent to POST /api/quotes and the draft export endpoints. */
export interface QuotePayloadItem {
  product_id: number;
  material_type: string | null;
  size_id: number | null;
  color_id: number;
  linear_feet: number;
  additional_costs_cents: number;
  additional_costs_description: string | null;
  note: string | null;
}

export interface IssuedQuote {
  id: number;
  quote_number: string;
  quote_date: string;
  customer_name: string | null;
  seller_name: string | null;
  total_cents: number;
  created_by: string | null;
  created_at: string;
}

export interface IssuedQuoteItem {
  id: number;
  quote_id: number;
  source_product_id: number | null;
  source_color_id: number | null;
  product_name: string;
  product_image_path: string | null;
  material_type: string | null;
  width_in: number | null;
  gauge: string | null;
  length_ft: number | null;
  color_name: string;
  color_hex: string;
  product_price_per_lf_cents: number;
  color_price_per_lf_cents: number;
  combined_price_per_lf_cents: number;
  linear_feet: number;
  additional_costs_cents: number;
  additional_costs_description: string | null;
  note: string | null;
  line_total_cents: number;
}

export interface IssuedQuoteDetail {
  quote: IssuedQuote;
  items: IssuedQuoteItem[];
}

export interface ToastMessage {
  id: number;
  type: 'success' | 'error';
  text: string;
}
