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
- Si hay voz en algún punto -> Modo normal (lyrics)
- Si no hay voz en todo el track -> Modo instrumental

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
- Segmentos SIN voz -> análisis de audio (energía, mood)
- Segmentos CON voz -> análisis de letra (actual)

**Dependencias:**
- `librosa` para extracción de features de audio
- Modelo de detección de voz (puede usar Whisper con threshold)

**Archivos a modificar:**
- `scripts/transcribe_audio.py` - Agregar detección de voz
- `scripts/analyze_lyrics.py` - Agregar branch para modo instrumental
- Nuevo: `scripts/analyze_audio.py` - Análisis de características de audio

---

### 2. LTX 2.3 Video Provider (Cloud-Only)
**Prioridad:** Media
**Complejidad:** Alta

**Descripción:**
Agregar un provider de video generativo basado en `LTX 2.3`, pero solo para cloud. No aplicar a desarrollo local ni a ejecución on-device con el hardware actual.

**Motivo:**
- Los requisitos oficiales de `LTX 2.3` exceden ampliamente el hardware local actual.
- El modelo requiere GPU de `32GB+ VRAM`, `32GB RAM` y `100GB+` libres.
- El workflow oficial de ComfyUI para `LTX 2.3` está pensado para una carga de modelo grande (`ltx-2.3-22b-dev`) y encoder pesado.

**No hacer localmente porque:**
- `RTX 3060 Laptop 6GB` no es suficiente
- el modo `low VRAM` documentado sigue apuntando a entornos de `32GB VRAM`
- forzar esto localmente solo agregaría inestabilidad y pérdida de tiempo

**Entrada a esta feature:**
Implementarla solo si se cumple al menos una de estas condiciones:

1. se decide lanzar video generativo en cloud con presupuesto asignado
2. se alcanza volumen suficiente como para justificar provider dedicado
3. se define una interfaz `VideoProvider` estable para soportar múltiples backends

**Arquitectura propuesta:**
- `video_provider=ltx_cloud`
- ejecución remota por:
  - API administrada, o
  - worker GPU cloud dedicado (`L40S`, `A100`, `H100`)
- el pipeline local actual sigue siendo el entorno de desarrollo principal

**Criterios de aceptación:**
- nunca bloquear el pipeline local si `ltx_cloud` está offline
- degradación controlada a provider alternativo o al modo imagen+render actual
- métricas separadas para:
  - tiempo por clip
  - costo por clip
  - tasa de error
  - calidad percibida

**Estimación de costo base:**
- `LTX API fast 1080p`: aprox. `$0.04/s`
- `LTX API pro 1080p`: aprox. `$0.06/s`
- para un video de `3 min`: rango aproximado `$7.20 - $10.80`

**Precondiciones técnicas:**
- abstracción `VideoProvider`
- flags/env para seleccionar provider
- cola aislada para trabajos de video
- presupuesto y alertas de costo

**Archivos probables a modificar:**
- nuevo: `src/modules/video/`
- nuevo: `scripts/generate_video_ltx.py` o worker equivalente
- config/env para `VIDEO_PROVIDER`
- jobs pipeline para enrutamiento cloud

---

## Ideas Pendientes

_(Agregar nuevas ideas aquí)_

---

## Completadas

_(Mover features completadas aquí)_
