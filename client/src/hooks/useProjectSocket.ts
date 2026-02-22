import { useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAuthToken } from '../services/authToken';

interface GeneratedImage {
    sceneIndex: number;
    totalScenes: number;
    imageUrl: string;
    prompt: string;
    timestamp: string;
}

interface JobUpdate {
    jobType: string;
    status: string;
    progress: number;
    currentStep?: string;
    timestamp: string;
}

interface UseProjectSocketOptions {
    projectId: string;
    enabled?: boolean;
}

interface UseProjectSocketReturn {
    images: GeneratedImage[];
    jobUpdate: JobUpdate | null;
    isConnected: boolean;
    videoUrl: string | null;
}

export function useProjectSocket({
    projectId,
    enabled = true,
}: UseProjectSocketOptions): UseProjectSocketReturn {
    const [images, setImages] = useState<GeneratedImage[]>([]);
    const [jobUpdate, setJobUpdate] = useState<JobUpdate | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [videoUrl, setVideoUrl] = useState<string | null>(null);
    const socketRef = useRef<Socket | null>(null);

    const handleImageGenerated = useCallback((data: GeneratedImage) => {
        setImages((prev) => {
            // Avoid duplicates
            const exists = prev.some((img) => img.sceneIndex === data.sceneIndex);
            if (exists) return prev;
            return [...prev, data].sort((a, b) => a.sceneIndex - b.sceneIndex);
        });
    }, []);

    const handleJobUpdate = useCallback((data: JobUpdate) => {
        setJobUpdate(data);
    }, []);

    const handleGenerationComplete = useCallback(
        (data: { videoUrl: string }) => {
            setVideoUrl(data.videoUrl);
        },
        []
    );

    useEffect(() => {
        if (!enabled || !projectId) return;

        // Connect to WebSocket server
        const token = getAuthToken();
        const socket = io('/events', {
            transports: ['websocket', 'polling'],
            auth: token ? { token } : undefined,
        });
        socketRef.current = socket;

        socket.on('connect', () => {
            console.log('[WS] Connected to events namespace');
            setIsConnected(false);
            // Join project room and only mark "connected" after successful room subscription.
            socket.emit(
                'join:project',
                { projectId },
                (response?: { success?: boolean; error?: string }) => {
                    if (response?.success) {
                        setIsConnected(true);
                        return;
                    }

                    setIsConnected(false);
                    console.warn(
                        `[WS] join:project rejected for ${projectId}: ${response?.error || 'unknown error'}`,
                    );
                },
            );
        });

        socket.on('disconnect', () => {
            console.log('[WS] Disconnected');
            setIsConnected(false);
        });

        socket.on('auth:error', (payload: { message?: string }) => {
            setIsConnected(false);
            console.warn(`[WS] auth:error ${payload?.message || 'unauthorized'}`);
        });

        socket.on('image:generated', handleImageGenerated);
        socket.on('job:update', handleJobUpdate);
        socket.on('generation:complete', handleGenerationComplete);

        return () => {
            socket.emit('leave:project', { projectId });
            socket.disconnect();
            socketRef.current = null;
        };
    }, [projectId, enabled, handleImageGenerated, handleJobUpdate, handleGenerationComplete]);

    // Reset state when projectId changes
    useEffect(() => {
        setImages([]);
        setJobUpdate(null);
        setVideoUrl(null);
    }, [projectId]);

    return {
        images,
        jobUpdate,
        isConnected,
        videoUrl,
    };
}
