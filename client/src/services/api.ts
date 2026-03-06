import axios from 'axios';
import type { Project } from '../types';
import {
    clearAuthToken,
    getAuthToken,
    getRefreshToken,
    setAuthTokens,
} from './authToken';
import { unwrapData, unwrapError } from './apiEnvelope';

const api = axios.create({
    baseURL: '/api/v1',
    withCredentials: true, // send HttpOnly cookie when backend sets one
});

let refreshInFlight: Promise<string | null> | null = null;

const refreshAccessToken = async (): Promise<string | null> => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) {
        clearAuthToken();
        return null;
    }

    if (!refreshInFlight) {
        refreshInFlight = axios
            .post('/api/v1/auth/refresh', { refreshToken })
            .then((response) => {
                const accessToken = response.data?.accessToken as string | undefined;
                const nextRefreshToken = response.data?.refreshToken as string | undefined;
                if (!accessToken) {
                    clearAuthToken();
                    return null;
                }

                setAuthTokens(accessToken, nextRefreshToken);
                return accessToken;
            })
            .catch(() => {
                clearAuthToken();
                return null;
            })
            .finally(() => {
                refreshInFlight = null;
            });
    }

    return refreshInFlight;
};

api.interceptors.request.use((config) => {
    const token = getAuthToken();
    if (!token) {
        return config;
    }

    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
    return config;
});

// ─── Envelope normalizer: unwrap { ok, data, meta } or pass-through legacy ───
api.interceptors.response.use(
    (response) => {
        // Unwrap envelope success shape so callers always get the inner data
        response.data = unwrapData(response.data);
        return response;
    },
    async (error) => {
        // Normalize error body so callers see a consistent shape
        if (error?.response?.data) {
            const norm = unwrapError(error.response.data);
            error.response.data = norm;
        }
        const originalRequest = error?.config as (Record<string, unknown> & {
            _retry?: boolean;
            _retryWithoutAuth?: boolean;
            url?: string;
            headers?: Record<string, string>;
        }) | undefined;

        const status = error?.response?.status;
        const url = String(originalRequest?.url || '');
        const isAuthRequest = url.includes('/auth/refresh') || url.includes('/auth/login/dev');

        if (status !== 401) {
            return Promise.reject(error);
        }

        if (isAuthRequest) {
            clearAuthToken();
            return Promise.reject(error);
        }

        if (!originalRequest || originalRequest._retry) {
            clearAuthToken();
            return Promise.reject(error);
        }

        originalRequest._retry = true;
        const newAccessToken = await refreshAccessToken();
        if (!newAccessToken) {
            clearAuthToken();
            if (!originalRequest._retryWithoutAuth) {
                originalRequest._retryWithoutAuth = true;
                originalRequest.headers = originalRequest.headers || {};
                delete originalRequest.headers.Authorization;
                return api(originalRequest);
            }
            return Promise.reject(error);
        }

        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(originalRequest);
    },
);

// Feedback types for AI learning
export interface FeedbackData {
    score: number;       // 1 = Like, -1 = Dislike
    prompt: string;
    frameTime?: number;
    sceneIndex?: number;
    style?: string;
    tags?: string[];
}

interface FeedbackStats {
    style: string;
    totalLikes: number;
    totalDislikes: number;
    successRate: number;
    topSuccessfulKeywords: string[];
}

export const projectService = {
    getAll: async () => {
        const response = await api.get<{ data: Project[] }>('/projects');
        return response.data.data;
    },

    create: async (youtubeUrl: string, title: string, visualStyle?: string, aspectRatio?: string) => {
        const response = await api.post<Project>('/projects', {
            youtubeUrl,
            title,
            visualStyle,
            aspectRatio
        });
        return response.data;
    },

    startGeneration: async (projectId: string, visualStyle: string = 'Cinematic') => {
        const response = await api.post(`/projects/${projectId}/generate`, { visualStyle });
        return response.data;
    },

    getOne: async (id: string) => {
        const response = await api.get<Project>(`/projects/${id}`);
        return response.data;
    },

    delete: async (id: string) => {
        const response = await api.delete(`/projects/${id}`);
        return response.data;
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // AI Feedback (Learning System)
    // ═══════════════════════════════════════════════════════════════════════════

    sendFeedback: async (projectId: string, data: FeedbackData) => {
        const response = await api.post(`/projects/${projectId}/feedback`, data);
        return response.data;
    },

    getFeedback: async (projectId: string) => {
        const response = await api.get(`/projects/${projectId}/feedback`);
        return response.data;
    },

    getFeedbackStats: async (style?: string): Promise<FeedbackStats> => {
        const params = style ? { style } : {};
        const response = await api.get<FeedbackStats>('/projects/feedback/stats', { params });
        return response.data;
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // Live Steering (Real-time direction during generation)
    // ═══════════════════════════════════════════════════════════════════════════

    sendLiveSignal: async (projectId: string, signal: {
        type: 'boost' | 'correct';
        sceneIndex: number;
        timestamp?: number;
        intensity?: number;  // 0.5-2.0, default 1.0
        reason?: string;     // Optional reason from user
    }) => {
        const response = await api.post(`/projects/${projectId}/live-signal`, {
            ...signal,
            timestamp: signal.timestamp || Date.now(),
            intensity: signal.intensity || 1.0
        });
        return response.data;
    },

    getLiveSignal: async (projectId: string) => {
        const response = await api.get(`/projects/${projectId}/live-signal`);
        return response.data;
    },

    clearLiveSignal: async (projectId: string) => {
        const response = await api.delete(`/projects/${projectId}/live-signal`);
        return response.data;
    }
};
