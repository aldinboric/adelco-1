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
  const result = {} as UserPermissions;
  for (const key of Object.keys(ALL_PERMISSIONS) as PermissionKey[]) {
    result[key] = typeof src[key] === 'boolean' ? src[key] : fallback[key];
  }

  // Enforce coherent dependency: manage implies view
  if (result.issued_quotes_manage) result.issued_quotes_view = true;
  if (result.products_manage) result.products_view = true;
  if (result.colors_manage) result.colors_view = true;

  return result;
}

/** Single permission check shared by the backend (auth.ts) and frontend (App.tsx). */
export function roleHasPermission(
  role: UserRole,
  permissions: UserPermissions,
  key: PermissionKey
): boolean {
  if (role === 'admin') return true;
  return Boolean(permissions[key]);
}
