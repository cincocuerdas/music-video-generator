# Feature Backlog

## Futuras Features

### 1. Modo Instrumental / Experimental
**Prioridad:** Media
**Complejidad:** Alta

**Descripción:**
Cuando una canción es completamente instrumental (sin voz), la app debería analizar el audio en sí mismo y generar imágenes basadas en "sensaciones" musicales en lugar de letra.

**Detección inteligente:**
- Escanear TODO el audio buscando presencia de voz
- Distinguir entre "intro instrumental" vs "canción instrumental"
- Si hay voz en algún punto → Modo normal (lyrics)
- Si no hay voz en todo el track → Modo instrumental

**Análisis de audio (librosa):**
| Característica | Sensación Visual |
|----------------|------------------|
| Tempo/BPM alto | Movimiento rápido, colores vibrantes |
| Tempo/BPM bajo | Transiciones lentas, atmósfera contemplativa |
| Energía alta | Explosiones de color, geometría agresiva |
| Energía baja | Texturas suaves, paisajes etéreos |
| Tonalidad menor | Colores fríos, sombras, melancolía |
| Tonalidad mayor | Colores cálidos, luz, optimismo |
| Frecuencias graves | Formas pesadas, profundidad |
| Frecuencias agudas | Destellos, partículas, ligereza |

**Segmentación híbrida:**
- Segmentos SIN voz → análisis de audio (energía, mood)
- Segmentos CON voz → análisis de letra (actual)

**Dependencias:**
- `librosa` para extracción de features de audio
- Modelo de detección de voz (puede usar Whisper con threshold)

**Archivos a modificar:**
- `scripts/transcribe_audio.py` - Agregar detección de voz
- `scripts/analyze_lyrics.py` - Agregar branch para modo instrumental
- Nuevo: `scripts/analyze_audio.py` - Análisis de características de audio

---

## Ideas Pendientes

_(Agregar nuevas ideas aquí)_

---

## Completadas

_(Mover features completadas aquí)_
