#!/usr/bin/env python3
"""
Test script for analyze_lyrics.py with LLM integration.
Run this to verify your API keys are configured correctly.

Usage: python test_analysis.py
"""

import os
import sys
import json

# Add scripts directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Sample lyrics for testing
SAMPLE_LYRICS_ES = """
Camino solo bajo la lluvia
Las luces de neón se reflejan en el suelo

La ciudad duerme en silencio
Mientras yo busco tu recuerdo

Las estrellas no brillan esta noche
Solo hay nubes y melancolía

Pero sigo adelante
Porque sé que el sol volverá
"""

SAMPLE_LYRICS_EN = """
Walking alone beneath the rain
Neon lights reflect upon the ground

The city sleeps in silence
While I search for your memory

The stars don't shine tonight
Only clouds and melancholy

But I keep moving forward
Because I know the sun will return
"""


def test_analysis():
    """Test the lyrics analysis."""
    print("=" * 60)
    print("Testing Lyrics Analysis with LLM")
    print("=" * 60)
    
    # Check environment
    provider = os.environ.get('LLM_PROVIDER', 'anthropic')
    print(f"\nLLM Provider: {provider}")
    
    if provider == 'anthropic':
        api_key = os.environ.get('ANTHROPIC_API_KEY', '')
        if api_key:
            print(f"Anthropic API Key: {api_key[:10]}...{api_key[-4:]}")
        else:
            print("⚠️  ANTHROPIC_API_KEY not set!")
            print("Set it with: export ANTHROPIC_API_KEY=sk-ant-...")
            return
    elif provider == 'openai':
        api_key = os.environ.get('OPENAI_API_KEY', '')
        if api_key:
            print(f"OpenAI API Key: {api_key[:10]}...{api_key[-4:]}")
        else:
            print("⚠️  OPENAI_API_KEY not set!")
            print("Set it with: export OPENAI_API_KEY=sk-...")
            return
    
    # Import analysis module
    try:
        from analysis.analyze_lyrics import analyze_lyrics_with_llm, analyze_lyrics_fallback
    except ImportError as e:
        print(f"\n❌ Import error: {e}")
        print("Make sure you're running from the scripts directory")
        return
    
    # Test with Spanish lyrics
    print("\n" + "-" * 60)
    print("Testing with Spanish lyrics...")
    print("-" * 60)
    
    try:
        result = analyze_lyrics_with_llm(SAMPLE_LYRICS_ES, "cinematic, dramatic lighting")
        print("\n✅ LLM Analysis successful!")
        print(f"\nLanguage: {result.get('language')}")
        print(f"Sentiment: {result.get('sentiment', {}).get('overall')} (intensity: {result.get('sentiment', {}).get('intensity')})")
        print(f"Total Verses: {result.get('totalVerses')}")
        
        print("\nVisual Prompts Generated:")
        for verse in result.get('verses', []):
            print(f"\n  [{verse['index']}] Original: {verse['originalText'][:50]}...")
            print(f"      Prompt: {verse['visualPrompt'][:100]}...")
        
        # Save full result to file
        output_file = 'test_analysis_result.json'
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"\n📄 Full result saved to: {output_file}")
        
    except Exception as e:
        print(f"\n❌ LLM Analysis failed: {e}")
        print("\nTrying fallback analysis...")
        result = analyze_lyrics_fallback(SAMPLE_LYRICS_ES, "cinematic")
        print(f"Fallback result: {len(result.get('verses', []))} verses analyzed")
    
    print("\n" + "=" * 60)
    print("Test complete!")
    print("=" * 60)


if __name__ == "__main__":
    test_analysis()
