import React from 'react';
import { Languages, Sun, Moon } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';

export const SettingsToggle: React.FC = () => {
    const { language, setLanguage } = useLanguage();
    const { toggleTheme, isDark } = useTheme();

    return (
        <div className="flex items-center gap-2 bg-white/5 dark:bg-gray-800/50 light:bg-gray-100 p-1.5 rounded-full px-3 border border-white/10 dark:border-gray-700 light:border-gray-200">
            {/* Language Selector */}
            <button
                onClick={() => setLanguage(language === 'es' ? 'en' : 'es')}
                className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-gray-400 hover:text-stitch-cyan transition-colors"
                title={language === 'es' ? 'Switch to English' : 'Cambiar a Español'}
            >
                <Languages size={14} />
                <span className="min-w-[20px]">{language.toUpperCase()}</span>
            </button>

            <div className="w-px h-4 bg-white/10 dark:bg-gray-600" />

            {/* Theme Toggle */}
            <button
                onClick={toggleTheme}
                className={`p-1 rounded-full transition-all ${isDark
                        ? 'text-gray-400 hover:text-yellow-400'
                        : 'text-yellow-500 hover:text-yellow-600'
                    }`}
                title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
                {isDark ? <Moon size={14} /> : <Sun size={14} />}
            </button>
        </div>
    );
};
