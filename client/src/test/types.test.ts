import { describe, it, expect } from 'vitest';
import type { Project, GeneratedImage, AnalysisScene, AnalysisResult } from '../types';

describe('types', () => {
    it('Project satisfies the expected shape', () => {
        const project: Project = {
            id: '1',
            title: 'Test Project',
            status: 'DRAFT',
            youtubeUrl: 'https://youtube.com/watch?v=test',
            createdAt: new Date().toISOString(),
        };
        expect(project.id).toBe('1');
        expect(project.status).toBe('DRAFT');
    });

    it('GeneratedImage has all required fields', () => {
        const img: GeneratedImage = {
            sceneIndex: 0,
            imageUrl: 'https://example.com/img.png',
            prompt: 'A sunset over the ocean',
            status: 'success',
        };
        expect(img.sceneIndex).toBe(0);
        expect(img.isFallback).toBeUndefined();
    });

    it('AnalysisScene includes optional startTime', () => {
        const scene: AnalysisScene = {
            verseText: 'Hello world',
            visualPrompt: 'A greeting scene',
            duration: 5,
            startTime: 10.5,
        };
        expect(scene.startTime).toBe(10.5);
    });

    it('AnalysisResult tracks degraded state', () => {
        const result: AnalysisResult = {
            status: 'degraded',
            degraded: true,
            degradedReasons: ['Fallback images used'],
            generatedImages: [],
            scenes: [],
        };
        expect(result.status).toBe('degraded');
        expect(result.degradedReasons).toHaveLength(1);
    });
});
