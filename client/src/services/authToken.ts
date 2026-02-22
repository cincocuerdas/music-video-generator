const ACCESS_TOKEN_KEYS = ['auth_token', 'token'];
const REFRESH_TOKEN_KEYS = ['refresh_token'];

export function getAuthToken(): string | null {
    if (typeof window === 'undefined') {
        return null;
    }

    for (const key of ACCESS_TOKEN_KEYS) {
        const value = window.localStorage.getItem(key);
        if (value && value.trim()) {
            return value.trim();
        }
    }

    return null;
}

export function getRefreshToken(): string | null {
    if (typeof window === 'undefined') {
        return null;
    }

    for (const key of REFRESH_TOKEN_KEYS) {
        const value = window.localStorage.getItem(key);
        if (value && value.trim()) {
            return value.trim();
        }
    }

    return null;
}

function setAuthToken(token: string): void {
    if (typeof window === 'undefined') {
        return;
    }

    const normalized = token.trim();
    if (!normalized) {
        return;
    }

    window.localStorage.setItem('auth_token', normalized);
}

export function setAuthTokens(accessToken: string, refreshToken?: string): void {
    setAuthToken(accessToken);

    if (typeof window === 'undefined' || !refreshToken) {
        return;
    }

    const normalizedRefresh = refreshToken.trim();
    if (!normalizedRefresh) {
        return;
    }

    window.localStorage.setItem('refresh_token', normalizedRefresh);
}

export function clearAuthToken(): void {
    if (typeof window === 'undefined') {
        return;
    }

    for (const key of ACCESS_TOKEN_KEYS) {
        window.localStorage.removeItem(key);
    }

    for (const key of REFRESH_TOKEN_KEYS) {
        window.localStorage.removeItem(key);
    }
}
