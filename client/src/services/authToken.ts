// ─── Token storage strategy ────────────────────────────────────────────
// Access token: kept in-memory only (never persisted to localStorage).
// Refresh token: when the backend sets an HttpOnly cookie on /auth/refresh
//   and /auth/login/dev, the browser sends it automatically — no JS access
//   needed. Until that backend change lands, we fall back to an in-memory
//   variable so the existing login/bootstrap flow keeps working in local dev.
// ────────────────────────────────────────────────────────────────────────

let _accessToken: string | null = null;
let _refreshToken: string | null = null;

// Legacy localStorage keys — only read once during migration, then removed.
const LEGACY_ACCESS_KEYS = ['auth_token', 'token'];
const LEGACY_REFRESH_KEYS = ['refresh_token'];

/** One-time migration: pull tokens from localStorage into memory and wipe storage. */
function migrateLegacyTokens(): void {
    if (typeof window === 'undefined') return;

    for (const key of LEGACY_ACCESS_KEYS) {
        const val = window.localStorage.getItem(key);
        if (val?.trim()) {
            _accessToken ??= val.trim();
            window.localStorage.removeItem(key);
        }
    }
    for (const key of LEGACY_REFRESH_KEYS) {
        const val = window.localStorage.getItem(key);
        if (val?.trim()) {
            _refreshToken ??= val.trim();
            window.localStorage.removeItem(key);
        }
    }
}

// Run migration eagerly on module load.
migrateLegacyTokens();

export function getAuthToken(): string | null {
    return _accessToken;
}

export function getRefreshToken(): string | null {
    // When the backend sends the refresh token as an HttpOnly cookie,
    // this function returns null and the browser handles it via credentials.
    return _refreshToken;
}

export function setAuthTokens(accessToken: string, refreshToken?: string): void {
    const normalizedAccess = accessToken?.trim();
    if (normalizedAccess) {
        _accessToken = normalizedAccess;
    }

    if (refreshToken) {
        const normalizedRefresh = refreshToken.trim();
        if (normalizedRefresh) {
            _refreshToken = normalizedRefresh;
        }
    }
}

export function clearAuthToken(): void {
    _accessToken = null;
    _refreshToken = null;

    // Belt-and-suspenders: wipe any residual localStorage entries.
    if (typeof window !== 'undefined') {
        for (const key of [...LEGACY_ACCESS_KEYS, ...LEGACY_REFRESH_KEYS]) {
            window.localStorage.removeItem(key);
        }
    }
}
