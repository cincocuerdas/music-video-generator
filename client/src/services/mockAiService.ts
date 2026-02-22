// Mock AI Service - Simulates AI-powered features for the Director Dashboard
// In production, these would call actual AI APIs (GPT-4, Stable Diffusion, etc.)

const ALTERNATIVE_THUMBNAILS = [
    "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&q=80",
    "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=800&q=80",
    "https://images.unsplash.com/photo-1515630278258-407f66498911?w=800&q=80",
    "https://images.unsplash.com/photo-1563089145-599997674d42?w=800&q=80",
    "https://images.unsplash.com/photo-1534972195531-d756b9bfa9f2?w=800&q=80",
    "https://images.unsplash.com/photo-1575936123452-b67c3203c357?w=800&q=80",
    "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80",
    "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=800&q=80"
];

const ENHANCEMENT_KEYWORDS = [
    "highly detailed", "8k resolution", "cinematic lighting",
    "atmospheric fog", "sharp focus", "unreal engine 5 render",
    "dramatic shadows", "photorealistic", "volumetric lighting",
    "award-winning photography", "masterpiece quality", "hyper-detailed",
    "professional color grading", "depth of field", "ray tracing",
    "stunning composition", "ethereal glow", "moody atmosphere"
];

const STYLE_MODIFIERS: Record<string, string[]> = {
    cinematic: ["anamorphic lens", "film grain", "35mm", "directed by Christopher Nolan"],
    anime: ["studio ghibli style", "vibrant colors", "cel shaded", "manga inspired"],
    cyberpunk: ["neon lights", "rain-soaked streets", "blade runner aesthetic", "dystopian"],
    fantasy: ["magical particles", "enchanted forest", "mythical creatures", "ethereal beauty"]
};

export const mockAiService = {
    /**
     * Simulates LLM-powered prompt enhancement
     * Adds quality keywords and style-specific modifiers
     */
    enhancePrompt: async (currentPrompt: string, style?: string): Promise<string> => {
        return new Promise((resolve) => {
            setTimeout(() => {
                // Add 2-3 random quality keywords
                const shuffled = [...ENHANCEMENT_KEYWORDS].sort(() => 0.5 - Math.random());
                const keywords = shuffled.slice(0, Math.floor(Math.random() * 2) + 2);

                // Add style-specific modifiers if style is provided
                let styleModifiers: string[] = [];
                if (style && STYLE_MODIFIERS[style]) {
                    const styleKeywords = STYLE_MODIFIERS[style];
                    styleModifiers = [styleKeywords[Math.floor(Math.random() * styleKeywords.length)]];
                }

                // Check if keywords already exist to avoid duplicates
                const existingLower = currentPrompt.toLowerCase();
                const newKeywords = [...keywords, ...styleModifiers].filter(
                    k => !existingLower.includes(k.toLowerCase())
                );

                if (newKeywords.length > 0) {
                    resolve(`${currentPrompt}, ${newKeywords.join(", ")}`);
                } else {
                    // If all keywords already exist, add a generic enhancement
                    resolve(`${currentPrompt}, enhanced composition, professional quality`);
                }
            }, 800 + Math.random() * 400); // 800-1200ms of "thinking"
        });
    },

    /**
     * Simulates AI image regeneration
     * Returns a random high-quality stock image
     */
    regenerateImage: async (_prompt?: string): Promise<string> => {
        return new Promise((resolve) => {
            setTimeout(() => {
                const randomImage = ALTERNATIVE_THUMBNAILS[
                    Math.floor(Math.random() * ALTERNATIVE_THUMBNAILS.length)
                ];
                resolve(randomImage);
            }, 1500 + Math.random() * 1000); // 1.5-2.5s of "generation"
        });
    },

    /**
     * Simulates AI-powered lyric transcription improvement
     */
    improveLyrics: async (lyrics: string): Promise<string> => {
        return new Promise((resolve) => {
            setTimeout(() => {
                // Simple mock: capitalize first letter and add punctuation
                const improved = lyrics
                    .split(' ')
                    .map((word, idx) => idx === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)
                    .join(' ');

                const ending = improved.endsWith('.') || improved.endsWith('!') || improved.endsWith('?')
                    ? improved
                    : improved + '...';

                resolve(ending);
            }, 600);
        });
    },

    /**
     * Simulates AI-powered scene duration suggestion based on lyrics
     */
    suggestDuration: async (lyrics: string): Promise<number> => {
        return new Promise((resolve) => {
            setTimeout(() => {
                // Estimate based on word count (roughly 2.5 words per second for singing)
                const wordCount = lyrics.split(/\s+/).filter(w => w.length > 0).length;
                const suggestedDuration = Math.max(3, Math.min(12, Math.round(wordCount / 2.5)));
                resolve(suggestedDuration);
            }, 400);
        });
    }
};
