import { ConfigService } from '@nestjs/config';

export function validateAiProviderConfig(configService: ConfigService) {
  const nodeEnv = (configService.get<string>('app.nodeEnv') || process.env.NODE_ENV || 'development').trim().toLowerCase();
  if (nodeEnv !== 'production') return;

  const weakValues = new Set(['', 'replace_me', 'change_me']);
  const llmProvider = (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();
  const imageProvider = (process.env.IMAGE_PROVIDER || 'comfyui').trim().toLowerCase();

  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (llmProvider === 'gemini' && weakValues.has(geminiKey.toLowerCase())) {
    throw new Error('Unsafe production configuration: GEMINI_API_KEY is missing/placeholder while LLM_PROVIDER=gemini.');
  }

  const replicateToken = (process.env.REPLICATE_API_TOKEN || '').trim();
  if (imageProvider === 'replicate' && weakValues.has(replicateToken.toLowerCase())) {
    throw new Error('Unsafe production configuration: REPLICATE_API_TOKEN is missing/placeholder while IMAGE_PROVIDER=replicate.');
  }

  const comfyuiUrl = (process.env.COMFYUI_URL || '').trim();
  if (imageProvider === 'comfyui') {
    if (weakValues.has(comfyuiUrl.toLowerCase())) {
      throw new Error('Unsafe production configuration: COMFYUI_URL is missing/placeholder while IMAGE_PROVIDER=comfyui.');
    }
    if (!/^https?:\/\//i.test(comfyuiUrl)) {
      throw new Error('Unsafe production configuration: COMFYUI_URL must start with http:// or https://');
    }
  }
}
