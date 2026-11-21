export type AppTab = 'quote' | 'issued' | 'products' | 'colors' | 'admin';

// Role & permission types come from the shared module (single source of truth with the backend).
import type { UserPermissions, UserRole } from '../shared/permissions.ts';
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

export interface ProductMaterial {
  id: number;
  product_id: number;
  name: string;
  price_per_lf_cents: number;
  width_in: number | null;
  gauge: string | null;
  length_ft: number | null;
  sort_order: number;
  created_at: string;
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

export interface QuoteDraftItem {
  rowKey: string;
  product_id: number | null;
  material_type: string;
  color_id: number | null;
  width_input: string;
  gauge_input: string;
  length_input: string;
  linear_feet_input: string;
  additional_costs_input: string;
  additional_costs_description: string;
  productIssue?: 'unavailable' | 'deleted' | null;
  colorIssue?: 'unavailable' | 'deleted' | null;
  fallbackProductName?: string;
  fallbackColorName?: string;
  fallbackColorHex?: string;
}

export interface QuoteDraftState {
  customer_name: string;
  quote_date: string;
  items: QuoteDraftItem[];
  copiedFromQuoteNumber?: string | null;
}

export interface IssuedQuote {
  id: number;
  quote_number: string;
  quote_date: string;
  customer_name: string | null;
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
