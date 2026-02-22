import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { projectService } from '../services/api';
import { LazySettingsToggle } from '../components/LazySettingsToggle';
import type { Project } from '../types';
import { Loader2, Film } from 'lucide-react';

const DirectorDashboardScreen = lazy(() =>
    import('../components/DirectorDashboardScreen').then((m) => ({ default: m.DirectorDashboardScreen })),
);

export const DirectorPage: React.FC = () => {
    const { id } = useParams<{ id: string }>();
    const [pageState, setPageState] = useState<{ project: Project | null; loading: boolean; error: string | null }>({
        project: null,
        loading: true,
        error: null,
    });

    useEffect(() => {
        if (!id) return;

        const loadProject = async () => {
            let data: Project | null = null;
            try {
                data = await projectService.getOne(id);
            } catch (err) {
                console.error('Failed to load project:', err);
            }
            setPageState({ project: data, loading: false, error: data ? null : 'Failed to load project' });
        };

        loadProject();
    }, [id]);

    const handleSave = async (updates: Partial<Project>) => {
        if (!id) return;
        // TODO: Implement save logic when backend supports it
        console.log('Saving updates:', updates);
    };

    const handleRegenerateScene = async (sceneIndex: number, newPrompt: string) => {
        if (!id) return;
        // TODO: Implement regenerate logic when backend supports it
        console.log('Regenerating scene:', sceneIndex, 'with prompt:', newPrompt);
        // Simulate regeneration delay
        await new Promise(resolve => setTimeout(resolve, 2000));
    };

    if (pageState.loading) {
        return (
            <div className="min-h-screen bg-[#0a0a0c] flex items-center justify-center">
                <div className="text-center space-y-4">
                    <Loader2 size={48} className="animate-spin text-stitch-cyan mx-auto" />
                    <p className="text-white font-bold">Loading Studio...</p>
                    <p className="text-gray-500 text-sm">Preparing director mode</p>
                </div>
            </div>
        );
    }

    if (pageState.error || !pageState.project) {
        return (
            <div className="min-h-screen bg-[#0a0a0c] flex items-center justify-center">
                <div className="text-center space-y-4">
                    <Film size={48} className="text-gray-700 mx-auto" />
                    <p className="text-white font-bold">{pageState.error || 'Project not found'}</p>
                    <p className="text-gray-500 text-sm">Unable to load the director dashboard</p>
                </div>
            </div>
        );
    }

    return (
        <>
            {/* Settings Toggle - Top Right */}
            <div className="fixed top-6 right-6 z-50">
                <LazySettingsToggle />
            </div>

            <Suspense
                fallback={
                    <div className="min-h-screen bg-[#0a0a0c] flex items-center justify-center">
                        <Loader2 size={42} className="animate-spin text-stitch-cyan" />
                    </div>
                }
            >
                <DirectorDashboardScreen
                    project={pageState.project}
                    onSave={handleSave}
                    onRegenerateScene={handleRegenerateScene}
                />
            </Suspense>
        </>
    );
};
