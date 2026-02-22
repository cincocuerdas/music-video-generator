import { getAuthToken, setAuthTokens } from './authToken';

interface DevLoginResponse {
    accessToken?: string;
    refreshToken?: string;
    token?: string;
}

export async function ensureDevAuthToken(): Promise<void> {
    if (!import.meta.env.DEV) {
        return;
    }

    if (getAuthToken()) {
        return;
    }

    try {
        let response = await fetch('/api/v1/auth/login/dev', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: '00000000-0000-4000-8000-000000000001' }),
        });

        if (!response.ok) {
            response = await fetch('/api/v1/auth/dev-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: '00000000-0000-4000-8000-000000000001' }),
            });
        }

        if (!response.ok) {
            return;
        }

        const payload = (await response.json()) as DevLoginResponse;
        const accessToken = payload.accessToken || payload.token;
        if (!accessToken) {
            return;
        }

        // Support both login/dev (access+refresh) and legacy dev-token (access only).
        setAuthTokens(accessToken, payload.refreshToken);
    } catch {
        // Best-effort bootstrap for local development.
    }
}
