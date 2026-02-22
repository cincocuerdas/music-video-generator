import { useEffect } from 'react';

interface DirectorShortcutsProps {
    onPlayPause: () => void;
    onSeek: (seconds: number) => void;
    onToggleMute: () => void;
    onDeleteScene?: () => void;
    onNextScene?: () => void;
    onPrevScene?: () => void;
}

export const useDirectorShortcuts = ({
    onPlayPause,
    onSeek,
    onToggleMute,
    onDeleteScene,
    onNextScene,
    onPrevScene
}: DirectorShortcutsProps) => {

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if user is typing in an input or textarea
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

            switch (e.code) {
                case 'Space':
                case 'KeyK': // Standard editing shortcut (J-K-L)
                    e.preventDefault();
                    onPlayPause();
                    break;

                case 'ArrowLeft':
                case 'KeyJ': // Rewind
                    e.preventDefault();
                    onSeek(-5);
                    break;

                case 'ArrowRight':
                case 'KeyL': // Fast forward
                    e.preventDefault();
                    onSeek(5);
                    break;

                case 'KeyM':
                    onToggleMute();
                    break;

                case 'Backspace':
                case 'Delete':
                    if (onDeleteScene) {
                        e.preventDefault();
                        onDeleteScene();
                    }
                    break;

                case 'ArrowUp':
                    if (onPrevScene) {
                        e.preventDefault();
                        onPrevScene();
                    }
                    break;

                case 'ArrowDown':
                    if (onNextScene) {
                        e.preventDefault();
                        onNextScene();
                    }
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onPlayPause, onSeek, onToggleMute, onDeleteScene, onNextScene, onPrevScene]);
};
