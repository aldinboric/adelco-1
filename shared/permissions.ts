// Single source of truth for roles & permissions, shared by frontend (src/) and backend (server/).

export type UserRole = 'admin' | 'user';

export interface UserPermissions {
  customer_quote: boolean;
  issued_quotes_view: boolean;
  issued_quotes_manage: boolean;
  products_view: boolean;
  products_manage: boolean;
  colors_view: boolean;
  colors_manage: boolean;
  catalog_reorder: boolean;
  exports: boolean;
  backup_settings: boolean;
}

export type PermissionKey = keyof UserPermissions;

export const ALL_PERMISSIONS: UserPermissions = {
  customer_quote: true,
  issued_quotes_view: true,
  issued_quotes_manage: true,
  products_view: true,
  products_manage: true,
  colors_view: true,
  colors_manage: true,
  catalog_reorder: true,
  exports: true,
  backup_settings: true,
};

// Regular users do NOT get catalog_reorder by default — only admin can grant it.
export const DEFAULT_USER_PERMISSIONS: UserPermissions = {
  ...ALL_PERMISSIONS,
  catalog_reorder: false,
};

export const EMPTY_USER_PERMISSIONS: UserPermissions = Object.fromEntries(
  (Object.keys(ALL_PERMISSIONS) as PermissionKey[]).map((k) => [k, false])
) as unknown as UserPermissions;

export function sanitizePermissions(
  input: unknown,
  fallback: UserPermissions = DEFAULT_USER_PERMISSIONS
): UserPermissions {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const result: UserPermissions = {
    customer_quote: typeof src.customer_quote === 'boolean' ? src.customer_quote : fallback.customer_quote,
    issued_quotes_view: typeof src.issued_quotes_view === 'boolean' ? src.issued_quotes_view : fallback.issued_quotes_view,
    issued_quotes_manage: typeof src.issued_quotes_manage === 'boolean' ? src.issued_quotes_manage : fallback.issued_quotes_manage,
    products_view: typeof src.products_view === 'boolean' ? src.products_view : fallback.products_view,
    products_manage: typeof src.products_manage === 'boolean' ? src.products_manage : fallback.products_manage,
    colors_view: typeof src.colors_view === 'boolean' ? src.colors_view : fallback.colors_view,
    colors_manage: typeof src.colors_manage === 'boolean' ? src.colors_manage : fallback.colors_manage,
    catalog_reorder: typeof src.catalog_reorder === 'boolean' ? src.catalog_reorder : fallback.catalog_reorder,
    exports: typeof src.exports === 'boolean' ? src.exports : fallback.exports,
    backup_settings: typeof src.backup_settings === 'boolean' ? src.backup_settings : fallback.backup_settings,
  };

  // Enforce coherent dependency: manage implies view
  if (result.issued_quotes_manage) result.issued_quotes_view = true;
  if (result.products_manage) result.products_view = true;
  if (result.colors_manage) result.colors_view = true;

  return result;
}
