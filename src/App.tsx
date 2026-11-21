import {
  AlertCircle,
  Archive,
  CheckCircle2,
  DatabaseBackup,
  FilePlus2,
  Layers,
  LogOut,
  Menu,
  Palette,
  ShieldCheck,
  X,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmModal } from './components/ConfirmModal';
import { ForcePasswordChangeView } from './components/ForcePasswordChangeView';
import { LoginView } from './components/LoginView';
import { QuotePrintModal } from './components/QuotePrintModal';
import { SettingsBackupModal } from './components/SettingsBackupModal';

// Heavy workspace views are code-split and loaded on demand.
const AdminView = lazy(() => import('./components/AdminView').then((m) => ({ default: m.AdminView })));
const CustomerQuoteView = lazy(() =>
  import('./components/CustomerQuoteView').then((m) => ({ default: m.CustomerQuoteView }))
);
const IssuedQuotesView = lazy(() =>
  import('./components/IssuedQuotesView').then((m) => ({ default: m.IssuedQuotesView }))
);
const MetalColorsView = lazy(() =>
  import('./components/MetalColorsView').then((m) => ({ default: m.MetalColorsView }))
);
const MetalProductsView = lazy(() =>
  import('./components/MetalProductsView').then((m) => ({ default: m.MetalProductsView }))
);

const VIEW_FALLBACK = (
  <div className="flex items-center justify-center py-16 text-xs font-medium text-slate-500">
    Loading view...
  </div>
);
import { roleHasPermission, type PermissionKey } from '../shared/permissions.ts';
import type {
  AppTab,
  AuthUser,
  IssuedQuoteDetail,
  MetalColor,
  MetalProduct,
  QuoteDraftItem,
  QuoteDraftState,
  ToastMessage,
} from './types';
import { apiFetch, setUnauthorizedHandler } from './utils/api';
import { centsToDollarsInput, todayIsoDate } from './utils/format';

function createEmptyDraft(): QuoteDraftState {
  return {
    customer_name: '',
    seller_name: '',
    quote_date: todayIsoDate(),
    items: [],
    copiedFromQuoteNumber: null,
  };
}

function hasPermission(user: AuthUser | null, key: PermissionKey): boolean {
  if (!user || !user.is_active) return false;
  return roleHasPermission(user.role, user.permissions, key);
}

interface CopyQuoteApiResponse {
  customer_name: string;
  seller_name: string;
  quote_date: string;
  source_quote_number: string;
  items: Array<{
    product_id: number | null;
    material_type: string;
    color_id: number | null;
    width_in: number | null;
    gauge: string;
    length_ft: number | null;
    linear_feet: number;
    additional_costs_cents: number;
    additional_costs_description: string;
    note: string;
    productIssue: 'unavailable' | 'deleted' | null;
    colorIssue: 'unavailable' | 'deleted' | null;
    fallbackProductName: string;
    fallbackColorName: string;
    fallbackColorHex: string;
  }>;
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<AppTab>('quote');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [colors, setColors] = useState<MetalColor[]>([]);
  const [products, setProducts] = useState<MetalProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  const [draft, setDraft] = useState<QuoteDraftState>(createEmptyDraft);
  const [pendingTabSwitch, setPendingTabSwitch] = useState<AppTab | null>(null);
  const [confirmClearDraftOpen, setConfirmClearDraftOpen] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activePrintDetail, setActivePrintDetail] = useState<IssuedQuoteDetail | null>(null);
  const [quotesRefreshSignal, setQuotesRefreshSignal] = useState(0);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const notify = useCallback((type: 'success' | 'error', text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, type, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const resetSessionUiState = useCallback(() => {
    setActivePrintDetail(null);
    setSettingsOpen(false);
    setPendingTabSwitch(null);
    setConfirmClearDraftOpen(false);
    setMobileMenuOpen(false);
    setDraft(createEmptyDraft());
    setColors([]);
    setProducts([]);
  }, []);

  // Register global 401 session-expiration handler
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCurrentUser(null);
      resetSessionUiState();
      setSessionNotice('Your session expired or was signed out. Please sign in again.');
    });
    return () => setUnauthorizedHandler(null);
  }, [resetSessionUiState]);

  // Verify existing session cookie on startup
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await apiFetch('/api/auth/me');
        if (!active) return;
        if (res.ok) {
          const data = (await res.json()) as { user?: AuthUser };
          if (data.user) {
            setCurrentUser(data.user);
            setSessionNotice(null);
          }
        }
      } catch {
        // Stay on login screen if unreachable
      } finally {
        if (active) setAuthChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const canCustomerQuote = hasPermission(currentUser, 'customer_quote');
  const canViewIssued = hasPermission(currentUser, 'issued_quotes_view');
  const canManageIssued = hasPermission(currentUser, 'issued_quotes_manage');
  const canViewProducts = hasPermission(currentUser, 'products_view');
  const canManageProducts = hasPermission(currentUser, 'products_manage');
  const canViewColors = hasPermission(currentUser, 'colors_view');
  const canManageColors = hasPermission(currentUser, 'colors_manage');
  const canReorderCatalog = hasPermission(currentUser, 'catalog_reorder');
  const canExport = hasPermission(currentUser, 'exports');
  const canBackupSettings = hasPermission(currentUser, 'backup_settings');
  const isAdmin = currentUser?.role === 'admin';

  const navItems = useMemo(() => {
    const items: Array<{ id: AppTab; label: string; icon: typeof FilePlus2 }> = [];
    if (canCustomerQuote) items.push({ id: 'quote', label: 'Customer Quote', icon: FilePlus2 });
    if (canViewIssued) items.push({ id: 'issued', label: 'Issued Quotes', icon: Archive });
    if (canViewProducts) items.push({ id: 'products', label: 'Products', icon: Layers });
    if (canViewColors) items.push({ id: 'colors', label: 'Colors', icon: Palette });
    if (isAdmin) items.push({ id: 'admin', label: 'Admin', icon: ShieldCheck });
    return items;
  }, [canCustomerQuote, canViewIssued, canViewProducts, canViewColors, isAdmin]);

  // Ensure activeTab always points to an allowed tab
  useEffect(() => {
    if (!currentUser || navItems.length === 0) return;
    if (!navItems.some((item) => item.id === activeTab)) {
      setActiveTab(navItems[0].id);
    }
  }, [currentUser, navItems, activeTab]);

  const loadCatalogs = useCallback(async () => {
    if (!currentUser) return;
    const needColors = canViewColors || canCustomerQuote;
    const needProducts = canViewProducts || canCustomerQuote;

    if (!needColors && !needProducts) {
      setColors([]);
      setProducts([]);
      return;
    }

    setCatalogLoading(true);
    try {
      const [colorsRes, productsRes] = await Promise.all([
        needColors ? apiFetch('/api/colors') : Promise.resolve(null),
        needProducts ? apiFetch('/api/products') : Promise.resolve(null),
      ]);

      if ((colorsRes && !colorsRes.ok) || (productsRes && !productsRes.ok)) {
        throw new Error('Failed to load catalog data.');
      }

      const [colorsData, productsData] = await Promise.all([
        colorsRes ? (colorsRes.json() as Promise<MetalColor[]>) : Promise.resolve([]),
        productsRes ? (productsRes.json() as Promise<MetalProduct[]>) : Promise.resolve([]),
      ]);

      setColors(colorsData);
      setProducts(productsData);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to load catalog.');
    } finally {
      setCatalogLoading(false);
    }
  }, [currentUser, canViewColors, canViewProducts, canCustomerQuote, notify]);

  useEffect(() => {
    if (currentUser) {
      loadCatalogs();
    }
  }, [currentUser, loadCatalogs]);

  const isDraftDirty = Boolean(
    currentUser && (draft.items.length > 0 || draft.customer_name.trim() !== '')
  );

  // Warn if closing browser tab with an unissued quote draft
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDraftDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDraftDirty]);

  const handleLoginSuccess = (user: AuthUser) => {
    setSessionNotice(null);
    setCurrentUser(user);
    if (user.role === 'admin' || user.permissions.customer_quote) {
      setActiveTab('quote');
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Clear client state even if request failed
    } finally {
      setCurrentUser(null);
      resetSessionUiState();
      setSessionNotice(null);
    }
  };

  const requestTabChange = (target: AppTab) => {
    setMobileMenuOpen(false);
    if (target === activeTab) return;
    if (activeTab === 'quote' && isDraftDirty) {
      setPendingTabSwitch(target);
      return;
    }
    setActiveTab(target);
  };

  const confirmLeaveDraft = () => {
    const target = pendingTabSwitch;
    setDraft(createEmptyDraft());
    setPendingTabSwitch(null);
    if (target) {
      setActiveTab(target);
    }
  };

  const handleQuoteIssued = (detail: IssuedQuoteDetail) => {
    setDraft(createEmptyDraft());
    setQuotesRefreshSignal((n) => n + 1);
    setActivePrintDetail(detail);
  };

  const handleCopyToNewQuote = async (quoteId: number) => {
    try {
      const res = await apiFetch(`/api/quotes/${quoteId}/copy`, { method: 'POST' });
      const data = (await res.json()) as CopyQuoteApiResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to copy quote.');
      }

      const mappedItems: QuoteDraftItem[] = data.items.map((item, idx) => ({
        rowKey: `copied-${Date.now()}-${idx}`,
        product_id: item.product_id,
        material_type: item.material_type ?? '',
        color_id: item.color_id,
        width_input: item.width_in != null ? String(item.width_in) : '',
        gauge_input: item.gauge ?? '',
        length_input: item.length_ft != null ? String(item.length_ft) : '',
        linear_feet_input: String(item.linear_feet),
        additional_costs_input:
          item.additional_costs_cents > 0 ? centsToDollarsInput(item.additional_costs_cents) : '',
        additional_costs_description: item.additional_costs_description ?? '',
        note_input: item.note ?? '',
        productIssue: item.productIssue,
        colorIssue: item.colorIssue,
        fallbackProductName: item.fallbackProductName,
        fallbackColorName: item.fallbackColorName,
        fallbackColorHex: item.fallbackColorHex,
      }));

      setDraft({
        customer_name: data.customer_name,
        seller_name: data.seller_name,
        quote_date: data.quote_date,
        items: mappedItems,
        copiedFromQuoteNumber: data.source_quote_number,
      });
      setActivePrintDetail(null);
      setActiveTab('quote');
      notify('success', `Copied ${data.source_quote_number} into a new draft quote.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to copy quote.');
    }
  };

  const handleRestored = async () => {
    setDraft(createEmptyDraft());
    await loadCatalogs();
    setQuotesRefreshSignal((n) => n + 1);
    try {
      const res = await apiFetch('/api/auth/me');
      if (res.ok) {
        const data = (await res.json()) as { user?: AuthUser };
        if (data.user) setCurrentUser(data.user);
      }
    } catch {
      // Ignore refresh failure
    }
  };

  const headerTitleMap: Record<AppTab, string> = {
    quote: 'Customer Quote',
    issued: 'Issued Quotes',
    products: 'Products',
    colors: 'Colors',
    admin: 'Admin',
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#f7f7f7] flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <img
            src="/assets/logo/Company_logo_1.0__Clean__no_black_shadow__bfc97f74.svg"
            alt="AdelCo Inc."
            className="h-12 w-12 object-contain"
          />
          <p className="text-xs font-medium text-slate-500">Verifying session...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginView onLoginSuccess={handleLoginSuccess} sessionNotice={sessionNotice} />;
  }

  // Accounts flagged with must_change_password (e.g. the seeded default admin) are locked
  // to this screen until they set a new password — enforced server-side as well.
  if (currentUser.must_change_password) {
    return <ForcePasswordChangeView currentUser={currentUser} onDone={setCurrentUser} />;
  }

  return (
    <div className="min-h-screen bg-[#f7f7f7] text-slate-900 flex">
      {/* Mobile Sidebar Backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Left Workspace Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white transition-transform duration-150 lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Company Brand Lockup */}
        <div className="flex h-16 items-center justify-between border-b border-slate-200 px-5">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/assets/logo/Company_logo_1.0__Clean__no_black_shadow__bfc97f74.svg"
              alt="AdelCo Inc. Logo"
              className="h-9 w-9 shrink-0 object-contain"
            />
            <span className="truncate text-base font-bold tracking-tight text-[#084091] whitespace-nowrap">
              AdelCo Inc.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 lg:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => requestTabChange(item.id)}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-medium whitespace-nowrap transition-colors ${
                  active
                    ? 'bg-[#084091] text-white'
                    : 'text-slate-700 hover:bg-[#f7f7f7] hover:text-slate-900'
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-white' : 'text-slate-500'}`} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Bottom Utility: Backup & Settings (if permitted) + Signed-In User & Sign Out */}
        <div className="border-t border-slate-200 p-3 space-y-2">
          {canBackupSettings && (
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                setSettingsOpen(true);
              }}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-[#f7f7f7] hover:text-slate-900 whitespace-nowrap transition-colors"
            >
              <DatabaseBackup className="h-4 w-4 shrink-0 text-[#2a6f3b]" />
              <span>Backup & Settings</span>
            </button>
          )}

          <div className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-[#f7f7f7] px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-slate-900">
                {currentUser.display_name}
              </div>
              <div className="truncate font-mono text-[11px] text-slate-500">
                @{currentUser.username} · {isAdmin ? 'Admin' : 'User'}
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-red-50 hover:border-red-200 hover:text-red-700 transition-colors"
              title="Sign Out"
            >
              <LogOut className="h-3 w-3" />
              Sign Out
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar */}
        <header className="flex h-16 shrink-0 items-center justify-between gap-8 border-b border-slate-200 bg-white px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50 lg:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="text-base font-bold text-slate-900 truncate whitespace-nowrap">
              {navItems.length > 0 ? headerTitleMap[activeTab] : 'Workspace Access'}
            </h1>
          </div>
        </header>

        {/* Active View Canvas */}
        <main className="flex-1 p-6">
          <div className="mx-auto max-w-[1280px] space-y-4">
            {navItems.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-white px-6 py-14 text-center">
                <h2 className="text-sm font-semibold text-slate-900">No Modules Enabled</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Your account currently has no workspace modules enabled. Contact your administrator to adjust permissions.
                </p>
              </div>
            ) : (
              <Suspense fallback={VIEW_FALLBACK}>
                {activeTab === 'quote' && canCustomerQuote && (
                  <CustomerQuoteView
                    draft={draft}
                    onChangeDraft={setDraft}
                    products={products}
                    colors={colors}
                    canExport={canExport}
                    onQuoteIssued={handleQuoteIssued}
                    onClearDraftConfirmed={() => setConfirmClearDraftOpen(true)}
                    onNotify={notify}
                  />
                )}

                {activeTab === 'issued' && canViewIssued && (
                  <IssuedQuotesView
                    onOpenQuoteDetail={setActivePrintDetail}
                    onCopyToNewQuote={handleCopyToNewQuote}
                    onStartNewQuote={() => setActiveTab('quote')}
                    onNotify={notify}
                    refreshSignal={quotesRefreshSignal}
                    canManage={canManageIssued}
                    canExport={canExport}
                    canCreateQuote={canCustomerQuote}
                  />
                )}

                {activeTab === 'products' && canViewProducts && (
                  <MetalProductsView
                    products={products}
                    loading={catalogLoading}
                    canManage={canManageProducts}
                    canReorder={canReorderCatalog}
                    canExport={canExport}
                    onRefresh={loadCatalogs}
                    onNotify={notify}
                  />
                )}

                {activeTab === 'colors' && canViewColors && (
                  <MetalColorsView
                    colors={colors}
                    loading={catalogLoading}
                    canManage={canManageColors}
                    canReorder={canReorderCatalog}
                    canExport={canExport}
                    onRefresh={loadCatalogs}
                    onNotify={notify}
                  />
                )}

                {activeTab === 'admin' && isAdmin && (
                  <AdminView
                    currentUser={currentUser}
                    onCurrentUserUpdated={setCurrentUser}
                    onNotify={notify}
                  />
                )}
              </Suspense>
            )}
          </div>
        </main>
      </div>

      {/* Modals */}
      <QuotePrintModal
        detail={activePrintDetail}
        onClose={() => setActivePrintDetail(null)}
        onCopyToNewQuote={handleCopyToNewQuote}
        onNotify={notify}
        canExport={canExport}
        canCopy={canManageIssued && canCustomerQuote}
      />

      {canBackupSettings && (
        <SettingsBackupModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onRestored={handleRestored}
          onNotify={notify}
        />
      )}

      <ConfirmModal
        open={pendingTabSwitch !== null}
        title="Unsaved Quote Draft"
        message="You have an unissued quote in progress. If you leave Customer Quote now without issuing or exporting, your current draft items will be cleared. Leave anyway?"
        confirmLabel="Leave Without Saving"
        cancelLabel="Stay on Quote"
        tone="danger"
        onConfirm={confirmLeaveDraft}
        onCancel={() => setPendingTabSwitch(null)}
      />

      <ConfirmModal
        open={confirmClearDraftOpen}
        title="Clear Quote Draft?"
        message="Are you sure you want to clear all items and customer details from the current unissued quote?"
        confirmLabel="Clear Draft"
        tone="danger"
        onConfirm={() => {
          setDraft(createEmptyDraft());
          setConfirmClearDraftOpen(false);
        }}
        onCancel={() => setConfirmClearDraftOpen(false)}
      />

      {/* Toast Stack */}
      {toasts.length > 0 && (
        <div className="no-print fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`flex items-center gap-2.5 rounded-lg border px-4 py-3 text-xs font-medium shadow-lg ${
                t.type === 'success'
                  ? 'border-[#2a6f3b]/30 bg-white text-slate-900'
                  : 'border-red-300 bg-red-50 text-red-800'
              }`}
            >
              {t.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-[#2a6f3b]" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
              )}
              <span>{t.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
