# Arquitectura: Generador de Videos Musicales con IA

## Resumen Ejecutivo

Sistema cloud-native orientado a eventos con procesamiento asíncrono en pipeline. Prioriza **literalidad semántica**, **consistencia visual** y **sincronización precisa**. Diseñado para músicos que necesitan videoclips publicables en plataformas como YouTube.

---

## 1. Arquitectura de Alto Nivel

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLIENTE (SPA)                                      │
│                      Next.js 14 + React + TailwindCSS                       │
│  ┌───────────┐  ┌────────────┐  ┌───────────┐  ┌─────────────────────────┐  │
│  │  Upload   │  │   Editor   │  │  Preview  │  │       Historial         │  │
│  │  Wizard   │  │   Letra    │  │   Video   │  │        Videos           │  │
│  └───────────┘  └────────────┘  └───────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ WebSocket + REST
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            API GATEWAY                                       │
│                      (Kong / AWS API Gateway)                               │
│          Rate Limiting │ Auth │ Request Validation │ CORS                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                  ┌───────────────────┼───────────────────┐
                  ▼                   ▼                   ▼
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│   AUTH SERVICE     │  │  PROJECT SERVICE   │  │ NOTIFICATION SVC   │
│   (Clerk/Auth0)    │  │   (NestJS)         │  │ (WebSocket Server) │
│                    │  │                    │  │                    │
│ • JWT Validation   │  │ • CRUD Projects    │  │ • Progress Updates │
│ • User Management  │  │ • Upload Handling  │  │ • Real-time Status │
│ • Session Control  │  │ • History Mgmt     │  │ • Error Notif.     │
└────────────────────┘  └────────────────────┘  └────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MESSAGE BROKER                                      │
│                     (AWS SQS + SNS / RabbitMQ)                              │
│                                                                              │
│   ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐              │
│   │ analysis  │  │ image-gen │  │  render   │  │  notify   │              │
│   │  queue    │  │   queue   │  │  queue    │  │  queue    │              │
│   └───────────┘  └───────────┘  └───────────┘  └───────────┘              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
      ┌───────────────┬───────────────┼───────────────┬───────────────┐
      ▼               ▼               ▼               ▼               ▼
┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐┌───────────┐
│  LANGUAGE   ││  SEMANTIC   ││   IMAGE     ││   VIDEO     ││  STORAGE  │
│  ANALYSIS   ││  PROCESSOR  ││  GENERATOR  ││  RENDERER   ││  SERVICE  │
│   WORKER    ││   WORKER    ││   WORKER    ││   WORKER    ││           │
│             ││             ││             ││             ││           │
│ • Detection ││ • NER/POS   ││ • FLUX/SDXL ││ • FFmpeg    ││ • S3/R2   │
│ • Translate ││ • Literal   ││ • Consisty. ││ • Motion    ││ • CDN     │
│ • Alignment ││   Extract   ││ • Style Lck ││ • Sync      ││           │
└─────────────┘└─────────────┘└─────────────┘└─────────────┘└───────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PERSISTENCE LAYER                                    │
│                                                                              │
│   ┌───────────────┐  ┌───────────────┐  ┌───────────────┐                  │
│   │  PostgreSQL   │  │    Redis      │  │   S3 / R2     │                  │
│   │  (Projects,   │  │  (Cache,      │  │  (Audio,      │                  │
│   │   Users,      │  │   Sessions,   │  │   Images,     │                  │
│   │   History)    │  │   Job State)  │  │   Videos)     │                  │
│   └───────────────┘  └───────────────┘  └───────────────┘                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Pipeline de Procesamiento

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PIPELINE DE PROCESAMIENTO                               │
└─────────────────────────────────────────────────────────────────────────────┘

FASE 1: INGESTA                    FASE 2: ANÁLISIS
┌───────────────────┐              ┌───────────────────────────────────────────┐
│                   │              │                                           │
│  ┌─────────────┐  │              │  ┌───────────┐    ┌─────────────────────┐│
│  │Audio Upload │──┼──────────────┼─▶│ Language  │───▶│  Semantic Analysis  ││
│  │ (MP3/WAV)   │  │              │  │ Detection │    │                     ││
│  └─────────────┘  │              │  │ (lingua)  │    │  • POS Tagging      ││
│                   │              │  └───────────┘    │  • NER Extraction   ││
│  ┌─────────────┐  │              │       │          │  • Dependency Parse  ││
│  │Letra Manual │──┼──────────────┼───────┘          │  • Scene Detection  ││
│  │(Timestamped)│  │              │                  └─────────────────────┘│
│  └─────────────┘  │              │                            │            │
│                   │              │                            ▼            │
│  ┌─────────────┐  │              │                  ┌─────────────────────┐│
│  │Estilo Visual│──┼──────────────┼─────────────────▶│  Literal Extractor  ││
│  │  (Preset)   │  │              │                  │                     ││
│  └─────────────┘  │              │                  │  • Subject          ││
│                   │              │                  │  • Action           ││
└───────────────────┘              │                  │  • Object           ││
                                   │                  │  • Setting          ││
                                   │                  │  • Explicit Emotion ││
                                   │                  └─────────────────────┘│
                                   └───────────────────────────────────────────┘
                                                              │
                                                              ▼
FASE 3: GENERACIÓN                 FASE 4: COMPOSICIÓN
┌───────────────────────────────┐  ┌───────────────────────────────────────────┐
│                               │  │                                           │
│  ┌─────────────────────────┐  │  │  ┌───────────────────────────────────┐   │
│  │   PROMPT CONSTRUCTOR    │  │  │  │      VIDEO COMPOSITOR             │   │
│  │                         │  │  │  │                                   │   │
│  │  Template:              │  │  │  │  Input:                           │   │
│  │  "{style}, {subject}    │  │  │  │  • Ordered images (PNG)           │   │
│  │   {action} {object},    │  │  │  │  • Timestamps per verse           │   │
│  │   in {setting},         │  │  │  │  • Audio track                    │   │
│  │   {lighting}, {mood}"   │  │  │  │  • Motion config                  │   │
│  │                         │  │  │  │                                   │   │
│  │  Negative: "abstract,   │  │  │  │  Process:                         │   │
│  │   metaphorical,symbolic"│  │  │  │  • Ken Burns effect               │   │
│  └─────────────────────────┘  │  │  │  • Cross-fade transitions         │   │
│            │                  │  │  │  • Audio sync                     │   │
│            ▼                  │  │  │  • Frame interpolation            │   │
│  ┌─────────────────────────┐  │  │  └───────────────────────────────────┘   │
│  │   IMAGE GENERATOR       │  │  │                  │                       │
│  │   (FLUX 1.1 Pro /       │  │  │                  ▼                       │
│  │    Stable Diffusion XL) │  │  │  ┌───────────────────────────────────┐   │
│  │                         │  │  │  │      FFMPEG RENDERER              │   │
│  │  • Batch generation     │  │  │  │                                   │   │
│  │  • Seed locking         │  │  │  │  Output:                          │   │
│  │  • Style consistency    │  │  │  │  • H.264 / AAC                    │   │
│  │  • ControlNet (opt)     │  │  │  │  • 1920x1080 @ 60fps              │   │
│  └─────────────────────────┘  │  │  │  • MP4 container                  │   │
│                               │  │  └───────────────────────────────────┘   │
└───────────────────────────────┘  └───────────────────────────────────────────┘
```

---

## 3. Extracción Semántica Literal (Componente Crítico)

Este es el corazón del sistema. El objetivo es extraer **solo elementos visualizables literalmente**.

### 3.1 Pipeline de Análisis

```
Input: "Camino solo bajo la lluvia en la ciudad dormida"

┌──────────────────────────────────────────────────────────────────────────┐
│  STEP 1: LANGUAGE DETECTION                                              │
│  Library: lingua-py                                                      │
│  Result: { language: "es", confidence: 0.98 }                           │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  STEP 2: MORPHOLOGICAL ANALYSIS (spaCy)                                  │
│                                                                          │
│  ┌─────────┬──────────┬──────────┬──────────┬───────────────────────┐   │
│  │  Token  │   POS    │   Lemma  │   Dep    │       Entity          │   │
│  ├─────────┼──────────┼──────────┼──────────┼───────────────────────┤   │
│  │ Camino  │  VERB    │ caminar  │  ROOT    │         -             │   │
│  │ solo    │  ADV     │ solo     │  advmod  │         -             │   │
│  │ bajo    │  ADP     │ bajo     │  case    │         -             │   │
│  │ la      │  DET     │ el       │  det     │         -             │   │
│  │ lluvia  │  NOUN    │ lluvia   │  obl     │  WEATHER_PHENOMENON   │   │
│  │ en      │  ADP     │ en       │  case    │         -             │   │
│  │ la      │  DET     │ el       │  det     │         -             │   │
│  │ ciudad  │  NOUN    │ ciudad   │  obl     │  LOCATION             │   │
│  │ dormida │  ADJ     │ dormido  │  amod    │         -             │   │
│  └─────────┴──────────┴──────────┴──────────┴───────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  STEP 3: LITERAL ELEMENT EXTRACTION                                      │
│                                                                          │
│  Rules:                                                                  │
│  • SUBJECT:  NOUN/PRON as nsubj or implied by VERB person               │
│              → "persona" (implied 1st person singular)                   │
│  • ACTION:   ROOT verb + dependent verbs                                 │
│              → "caminar"                                                 │
│  • MANNER:   ADV modifying action                                        │
│              → "solo" (alone)                                            │
│  • LOCATION: NOUN with LOC dependency or location entity                 │
│              → "ciudad" (city)                                           │
│  • WEATHER:  Weather-related nouns                                       │
│              → "lluvia" (rain)                                           │
│  • TIME:     Temporal modifiers                                          │
│              → "dormida" implies nighttime                               │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  STEP 4: SCENE COMPOSITION OUTPUT                                        │
│                                                                          │
│  {                                                                       │
│    "subject": {                                                          │
│      "type": "person",                                                   │
│      "count": 1,                                                         │
│      "state": "alone"                                                    │
│    },                                                                    │
│    "action": {                                                           │
│      "verb": "walking",                                                  │
│      "manner": "solitary"                                                │
│    },                                                                    │
│    "environment": {                                                      │
│      "location_type": "urban",                                           │
│      "specific": "city_street",                                          │
│      "weather": "rain",                                                  │
│      "time_of_day": "night"                                              │
│    },                                                                    │
│    "visual_elements": [                                                  │
│      "rain_falling",                                                     │
│      "wet_streets",                                                      │
│      "street_lights"                                                     │
│    ],                                                                    │
│    "excluded_interpretations": [                                         │
│      "metaphorical_loneliness",                                          │
│      "emotional_storm",                                                  │
│      "abstract_isolation"                                                │
│    ]                                                                     │
│  }                                                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Construcción de Prompts

```python
# Template de prompt estructurado
PROMPT_TEMPLATE = """
{style_prefix}, {subject} {action} {preposition} {location},
{weather_condition}, {time_lighting}, {atmosphere},
{technical_quality}
"""

NEGATIVE_PROMPT = """
abstract, metaphorical, symbolic, surreal, distorted faces,
conceptual art, expressionist, impressionist, dreamlike,
text, watermark, logo, signature, low quality, blurry
"""

# Ejemplo generado:
# "cinematic film still, 35mm photography, a lone person walking
#  through empty city streets at night, rain falling heavily,
#  wet pavement reflecting dim street lights, quiet sleeping city,
#  dramatic lighting, shallow depth of field, photorealistic"
```

---

## 4. Modelo de Datos

```sql
-- ═══════════════════════════════════════════════════════════════════════════
-- SCHEMA PRINCIPAL
-- ═══════════════════════════════════════════════════════════════════════════

-- Usuarios
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id     VARCHAR(255) UNIQUE NOT NULL,  -- Clerk/Auth0 ID
    email           VARCHAR(255) UNIQUE NOT NULL,
    display_name    VARCHAR(100),
    storage_quota   BIGINT DEFAULT 5368709120,     -- 5GB
    storage_used    BIGINT DEFAULT 0,
    tier            VARCHAR(20) DEFAULT 'free',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Proyectos de Video
CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Metadata
    title           VARCHAR(200) NOT NULL,
    description     TEXT,
    status          VARCHAR(30) DEFAULT 'draft',
    -- Estados: draft, processing, analyzing, generating, rendering, completed, failed
    
    -- Configuración
    visual_style    VARCHAR(50) NOT NULL,
    target_duration INTEGER,
    language        VARCHAR(10),                   -- ISO 639-1
    
    -- Archivos
    audio_url       TEXT,
    audio_duration  FLOAT,
    video_url       TEXT,
    thumbnail_url   TEXT,
    
    -- Timestamps
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    
    CONSTRAINT valid_status CHECK (status IN (
        'draft', 'processing', 'analyzing', 'generating', 
        'rendering', 'completed', 'failed'
    ))
);

CREATE INDEX idx_projects_user_status ON projects(user_id, status);
CREATE INDEX idx_projects_created ON projects(created_at DESC);

-- Versos/Líneas de la Letra
CREATE TABLE verses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    sequence        INTEGER NOT NULL,
    original_text   TEXT NOT NULL,
    normalized_text TEXT,
    
    -- Timing
    start_time      FLOAT NOT NULL,
    end_time        FLOAT NOT NULL,
    duration        FLOAT GENERATED ALWAYS AS (end_time - start_time) STORED,
    
    -- Análisis Semántico (JSONB)
    semantic_data   JSONB,
    /*
    {
        "subjects": ["persona"],
        "actions": ["caminar"],
        "objects": ["paraguas"],
        "settings": ["calle", "noche"],
        "emotions": ["tristeza"],
        "scene_type": "exterior_urban_night"
    }
    */
    
    generation_status VARCHAR(20) DEFAULT 'pending',
    
    UNIQUE(project_id, sequence)
);

-- Imágenes Generadas
CREATE TABLE generated_images (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    verse_id        UUID REFERENCES verses(id) ON DELETE CASCADE,
    
    prompt_used     TEXT NOT NULL,
    negative_prompt TEXT,
    seed            BIGINT,
    
    model_version   VARCHAR(50),
    style_preset    VARCHAR(50),
    generation_params JSONB,
    
    image_url       TEXT NOT NULL,
    width           INTEGER DEFAULT 1920,
    height          INTEGER DEFAULT 1080,
    
    motion_config   JSONB DEFAULT '{"type": "ken_burns", "zoom": 1.05}',
    
    generation_time FLOAT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    is_active       BOOLEAN DEFAULT true
);

-- Jobs de Procesamiento
CREATE TABLE processing_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    job_type        VARCHAR(30) NOT NULL,
    status          VARCHAR(20) DEFAULT 'queued',
    progress        INTEGER DEFAULT 0,
    current_step    VARCHAR(100),
    
    input_data      JSONB,
    output_data     JSONB,
    error_message   TEXT,
    
    queued_at       TIMESTAMPTZ DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    worker_id       VARCHAR(100)
);

-- Estilos Visuales
CREATE TABLE visual_styles (
    id              VARCHAR(50) PRIMARY KEY,
    display_name    VARCHAR(100) NOT NULL,
    description     TEXT,
    
    style_prefix    TEXT NOT NULL,
    style_suffix    TEXT,
    negative_prompt TEXT,
    
    example_images  TEXT[],
    recommended_model VARCHAR(50),
    default_params  JSONB,
    
    is_active       BOOLEAN DEFAULT true,
    sort_order      INTEGER DEFAULT 0
);

-- Datos iniciales de estilos
INSERT INTO visual_styles (id, display_name, style_prefix, negative_prompt) VALUES
('cinematic', 'Cinematográfico', 
 'cinematic film still, 35mm photography, dramatic lighting, shallow depth of field',
 'cartoon, anime, illustration, drawing, painting'),
('anime', 'Anime', 
 'anime style illustration, vibrant colors, detailed background, studio ghibli inspired',
 'realistic, photograph, 3d render'),
('digital_art', 'Arte Digital', 
 'digital art, detailed illustration, concept art, artstation trending',
 'photograph, realistic, blurry'),
('realistic', 'Fotorrealista', 
 'photorealistic, ultra detailed, professional photography, 8k resolution',
 'cartoon, drawing, illustration, anime'),
('watercolor', 'Acuarela', 
 'watercolor painting, soft colors, artistic, traditional media style',
 'digital, photograph, sharp edges'),
('pixel_art', 'Pixel Art', 
 '16-bit pixel art style, retro gaming aesthetic, detailed sprites',
 'realistic, photograph, smooth');
```

---

## 5. Stack Tecnológico

### 5.1 Frontend

| Componente | Tecnología | Justificación |
|------------|------------|---------------|
| Framework | Next.js 14 (App Router) | SSR, optimización automática, excelente DX |
| UI | TailwindCSS + shadcn/ui | Consistencia, componentes accesibles |
| State | Zustand + TanStack Query | Simple para cliente, potente para servidor |
| Real-time | Socket.io-client | Bidireccional, reconexión automática |
| Video | Video.js | Robusto, extensible, buena compatibilidad |
| Upload | react-dropzone + tus-client | Resumable uploads para archivos grandes |
| Forms | React Hook Form + Zod | Validación tipada, performance |

### 5.2 Backend API

| Componente | Tecnología | Justificación |
|------------|------------|---------------|
| Framework | NestJS 10 | Modular, TypeScript nativo, bien documentado |
| Runtime | Node.js 20 LTS | Estable, soporte largo |
| ORM | Prisma 5 | Type-safe, migraciones, buen DX |
| Queue | BullMQ | Redis-backed, robusto, UI de monitoreo |
| Auth | Clerk | Rápido de implementar, webhooks |
| WebSocket | Socket.io | Compatible con NestJS |

### 5.3 Workers (Python)

| Componente | Tecnología | Justificación |
|------------|------------|---------------|
| Runtime | Python 3.11 | Ecosistema ML maduro |
| NLP | spaCy 3.7 + transformers | Modelos multiidioma, NER robusto |
| Lang Detection | lingua-py | Más preciso que langdetect |
| Translation | Helsinki-NLP OPUS-MT | Self-hosted, sin costos por uso |
| Video | ffmpeg-python | Wrapper limpio para FFmpeg |
| Image Gen | Replicate SDK | API estable para FLUX |

### 5.4 Infraestructura

| Componente | Servicio | Configuración |
|------------|----------|---------------|
| Frontend | Vercel | Pro plan, edge functions |
| API | AWS ECS Fargate | 2 vCPU, 4GB RAM, auto-scaling |
| Workers | AWS ECS + RunPod | CPU para análisis, GPU para imágenes |
| Database | AWS RDS PostgreSQL 15 | db.t3.medium, Multi-AZ para prod |
| Cache | AWS ElastiCache Redis 7 | cache.t3.micro |
| Storage | AWS S3 + CloudFront | Intelligent Tiering |
| Queues | AWS SQS FIFO | Ordenamiento garantizado |
| Auth | Clerk | Free tier hasta 10K MAU |

### 5.5 Servicios de IA

| Servicio | Proveedor | Costo Aproximado |
|----------|-----------|------------------|
| Image Generation (primary) | Replicate FLUX 1.1 Pro | $0.05/imagen |
| Image Generation (fallback) | Together AI FLUX Schnell | $0.01/imagen |
| Image Generation (scale) | RunPod self-hosted SDXL | $0.005/imagen |
| Translation (optional) | DeepL API | $0.00002/char |

---

## 6. Renderizado de Video

### 6.1 Pipeline FFmpeg

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       VIDEO RENDERING PIPELINE                               │
└─────────────────────────────────────────────────────────────────────────────┘

STEP 1: MOTION APPLICATION (per image)
══════════════════════════════════════════════════════════════════════════════

Ken Burns Effect (zoom + pan):
┌────────────────────────────────────────────────────────────────────────────┐
│  ffmpeg -loop 1 -i image.png -vf "                                        │
│    scale=8000:-1,                                                          │
│    zoompan=z='min(zoom+0.0005,1.2)':                                       │
│           x='iw/2-(iw/zoom/2)':                                            │
│           y='ih/2-(ih/zoom/2)':                                            │
│           d={duration_frames}:                                             │
│           s=1920x1080:                                                     │
│           fps=60                                                           │
│  " -t {duration_seconds} -c:v libx264 segment.mp4                         │
└────────────────────────────────────────────────────────────────────────────┘

Motion Types:
• zoom_in:   Slow zoom towards center
• zoom_out:  Start zoomed, pull back  
• pan_left:  Horizontal left to right
• pan_right: Horizontal right to left
• pan_up:    Vertical bottom to top
• pan_down:  Vertical top to bottom
• static:    No motion

STEP 2: TRANSITIONS
══════════════════════════════════════════════════════════════════════════════

Cross-fade (0.5s default):
┌────────────────────────────────────────────────────────────────────────────┐
│  ffmpeg -i seg1.mp4 -i seg2.mp4 -filter_complex "                         │
│    [0:v][1:v]xfade=transition=fade:                                        │
│                     duration=0.5:                                          │
│                     offset={seg1_duration - 0.5}                           │
│  " output.mp4                                                              │
└────────────────────────────────────────────────────────────────────────────┘

STEP 3: CONCATENATION
══════════════════════════════════════════════════════════════════════════════

┌────────────────────────────────────────────────────────────────────────────┐
│  # concat.txt                                                              │
│  file 'segment_0.mp4'                                                      │
│  file 'segment_1.mp4'                                                      │
│  file 'segment_2.mp4'                                                      │
│  ...                                                                       │
│                                                                            │
│  ffmpeg -f concat -safe 0 -i concat.txt -c copy video_no_audio.mp4        │
└────────────────────────────────────────────────────────────────────────────┘

STEP 4: AUDIO MERGE
══════════════════════════════════════════════════════════════════════════════

┌────────────────────────────────────────────────────────────────────────────┐
│  ffmpeg -i video_no_audio.mp4 -i original_audio.mp3 \                     │
│    -c:v copy \                                                             │
│    -c:a aac -b:a 320k \                                                    │
│    -map 0:v:0 -map 1:a:0 \                                                 │
│    -shortest \                                                             │
│    final_output.mp4                                                        │
└────────────────────────────────────────────────────────────────────────────┘

OUTPUT SPECS:
• Container: MP4
• Video: H.264, 1920x1080, 60fps
• Audio: AAC 320kbps
```

### 6.2 Consistencia de Estilo

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                  STYLE CONSISTENCY MECHANISMS                                │
└─────────────────────────────────────────────────────────────────────────────┘

1. SEED STRATEGY
   • Master seed: seed_base = hash(project_id)
   • Per-verse:   seed_verse = seed_base + (verse_index * 1000)
   • Permite regenerar versos individuales sin afectar otros

2. STYLE EMBEDDINGS
   • Pre-computar embedding del style_prefix
   • Cache en Redis: key = f"style_embed:{style_id}:{model_version}"
   • Inyectar mismo embedding en todas las generaciones

3. PROMPT STRUCTURE
   • Mismo prefijo y sufijo de estilo para todo el proyecto
   • Negative prompt consistente
   • Parámetros técnicos fijos (steps, cfg_scale, etc.)
```

---

## 7. API REST (Principales Endpoints)

```yaml
# ═══════════════════════════════════════════════════════════════════════════
# PROJECTS
# ═══════════════════════════════════════════════════════════════════════════

GET    /api/v1/projects                    # Listar proyectos del usuario
POST   /api/v1/projects                    # Crear proyecto
GET    /api/v1/projects/{id}               # Obtener detalle
PATCH  /api/v1/projects/{id}               # Actualizar
DELETE /api/v1/projects/{id}               # Eliminar

# ═══════════════════════════════════════════════════════════════════════════
# AUDIO
# ═══════════════════════════════════════════════════════════════════════════

POST   /api/v1/projects/{id}/audio/upload-url    # Obtener presigned URL
POST   /api/v1/projects/{id}/audio/confirm       # Confirmar upload

# ═══════════════════════════════════════════════════════════════════════════
# VERSES (LYRICS)
# ═══════════════════════════════════════════════════════════════════════════

GET    /api/v1/projects/{id}/verses        # Listar versos
POST   /api/v1/projects/{id}/verses        # Crear versos (bulk)
PATCH  /api/v1/projects/{id}/verses/{vid}  # Actualizar verso
DELETE /api/v1/projects/{id}/verses/{vid}  # Eliminar verso

# ═══════════════════════════════════════════════════════════════════════════
# GENERATION
# ═══════════════════════════════════════════════════════════════════════════

POST   /api/v1/projects/{id}/generate      # Iniciar generación
GET    /api/v1/projects/{id}/status        # Estado de generación
POST   /api/v1/projects/{id}/cancel        # Cancelar

# ═══════════════════════════════════════════════════════════════════════════
# VIDEO OUTPUT
# ═══════════════════════════════════════════════════════════════════════════

GET    /api/v1/projects/{id}/video         # Metadata del video
GET    /api/v1/projects/{id}/download      # URL de descarga

# ═══════════════════════════════════════════════════════════════════════════
# STYLES
# ═══════════════════════════════════════════════════════════════════════════

GET    /api/v1/styles                      # Listar estilos disponibles
```

---

## 8. Flujo de Usuario (UI)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              UI FLOW                                         │
└─────────────────────────────────────────────────────────────────────────────┘

SCREEN 1: DASHBOARD
┌─────────────────────────────────────────────────────────────────────────────┐
│  HEADER: Logo | "Mis Videos" | [+ Nuevo Video] | Avatar                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  FILTROS: [Todos] [En proceso] [Completados] | Buscar: [________]           │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐                   │
│  │  [Thumbnail]   │ │  [Thumbnail]   │ │  [Thumbnail]   │                   │
│  │  "Canción 1"   │ │  "Demo Track"  │ │  "Cover"       │                   │
│  │  ████████ 100% │ │  ███░░░ 45%    │ │  ████████ 100% │                   │
│  │  [Ver] [⬇️]    │ │  Generando...  │ │  [Ver] [⬇️]    │                   │
│  └────────────────┘ └────────────────┘ └────────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────┘

SCREEN 2: WIZARD - UPLOAD
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEPPER: [1. Audio ●] → [2. Letra ○] → [3. Estilo ○] → [4. Review ○]      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│           ┌─────────────────────────────────────────────┐                   │
│           │      📁 Arrastrá tu archivo de audio       │                   │
│           │         MP3 o WAV (máx. 50MB)              │                   │
│           │              [Seleccionar]                  │                   │
│           └─────────────────────────────────────────────┘                   │
│                                                                              │
│           Título: [________________________]                                 │
│                                                    [Cancelar] [Siguiente →] │
└─────────────────────────────────────────────────────────────────────────────┘

SCREEN 3: WIZARD - LYRICS EDITOR
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEPPER: [1. Audio ✓] → [2. Letra ●] → [3. Estilo ○] → [4. Review ○]      │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────┬───────────────────────────────────────────┐│
│  │  REPRODUCTOR               │  EDITOR DE LETRA                          ││
│  │  ┌───────────────────────┐ │  ┌───────────────────────────────────────┐││
│  │  │    Waveform Visual    │ │  │ Verso 1:              [00:05]        │││
│  │  │  ▶️  00:45 / 03:20    │ │  │ Camino solo bajo la lluvia           │││
│  │  └───────────────────────┘ │  │                                       │││
│  │                             │  │ Verso 2:              [00:12]        │││
│  │  💡 Click en waveform      │  │ La ciudad duerme en silencio          │││
│  │  para marcar inicio        │  │                                       │││
│  │  de cada verso.            │  │ [+ Agregar verso]                     │││
│  │                             │  └───────────────────────────────────────┘││
│  └─────────────────────────────┴───────────────────────────────────────────┘│
│  Idioma detectado: Español 🇪🇸                    [← Atrás] [Siguiente →]  │
└─────────────────────────────────────────────────────────────────────────────┘

SCREEN 4: WIZARD - STYLE SELECTION
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEPPER: [1. Audio ✓] → [2. Letra ✓] → [3. Estilo ●] → [4. Review ○]      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Seleccioná un estilo visual:                                               │
│                                                                              │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐                   │
│  │ [Example] │ │ [Example] │ │ [Example] │ │ [Example] │                   │
│  │Cinematic  │ │  Anime    │ │  Digital  │ │ Realistic │                   │
│  │    ○      │ │    ●      │ │    ○      │ │    ○      │                   │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘                   │
│                                                                              │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐                   │
│  │ [Example] │ │ [Example] │ │ [Example] │ │ [Example] │                   │
│  │Watercolor │ │ 3D Render │ │ Pixel Art │ │  Vintage  │                   │
│  │    ○      │ │    ○      │ │    ○      │ │    ○      │                   │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘                   │
│                                                    [← Atrás] [Siguiente →]  │
└─────────────────────────────────────────────────────────────────────────────┘

SCREEN 5: PROCESSING
┌─────────────────────────────────────────────────────────────────────────────┐
│  "Mi Canción" - Generando video...                             [Cancelar]   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Progreso: ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░  45%                   │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  ✓ Análisis de idioma completado                                     │  │
│  │  ✓ Extracción semántica completada                                   │  │
│  │  ● Generando imágenes... (9/20)                                      │  │
│  │  ○ Renderizando video                                                │  │
│  │  ○ Mezclando audio                                                   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  Imagen actual:                                                             │
│  ┌─────────────────────────────────────┐                                   │
│  │     [Preview de imagen actual]      │                                   │
│  └─────────────────────────────────────┘                                   │
│  "Las luces parpadean en la noche fría"                                    │
│                                                                              │
│  💡 Podés cerrar esta página. Te notificaremos cuando esté listo.          │
└─────────────────────────────────────────────────────────────────────────────┘

SCREEN 6: VIDEO PREVIEW
┌─────────────────────────────────────────────────────────────────────────────┐
│  "Mi Canción" - Completado ✓                       [← Volver] [Descargar]   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                ┌─────────────────────────────────────┐                      │
│                │                                     │                      │
│                │         VIDEO PLAYER               │                      │
│                │          (1920x1080)                │                      │
│                │             ▶️                       │                      │
│                │                                     │                      │
│                └─────────────────────────────────────┘                      │
│                ━━━━━━━●━━━━━━━━━━━━━━━━━━━━━  01:23 / 03:20                │
│                                                                              │
│  Info: 3:20 | 1920x1080 | MP4 | Anime | 20 imágenes                        │
│                                                                              │
│  [🔗 Compartir]  [📋 Copiar link]  [🗑️ Eliminar]                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Estimación de Costos (1000 videos/mes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     COST ESTIMATION (MONTHLY)                                │
└─────────────────────────────────────────────────────────────────────────────┘

Assumptions:
• 1000 videos/month
• 20 verses (images) per video average
• 3 minutes average duration
• 1000 users, 10GB storage each

INFRASTRUCTURE
─────────────────────────────────────────────────────────────────────────────
Vercel (Frontend Pro)                                         $20/month
AWS ECS Fargate (API + Workers)                              $150/month
AWS RDS PostgreSQL (db.t3.medium)                            $50/month
AWS ElastiCache Redis (cache.t3.micro)                       $15/month
AWS S3 + CloudFront (10TB storage + 50TB transfer)          $300/month
AWS SQS (~1M requests)                                        $5/month
─────────────────────────────────────────────────────────────────────────────
                                           SUBTOTAL:         $540/month

AI/ML SERVICES
─────────────────────────────────────────────────────────────────────────────
Image Generation (Replicate FLUX)
  20,000 images × $0.05                                    $1,000/month
  
Translation (DeepL - optional)
  500K characters × $0.00002                                 $10/month
  
Clerk Auth (1000 MAU - free tier)                            $0/month
─────────────────────────────────────────────────────────────────────────────
                                           SUBTOTAL:       $1,010/month

VIDEO RENDERING (Compute)
─────────────────────────────────────────────────────────────────────────────
AWS ECS Fargate (video workers)
  ~2 min render × 1000 videos = 33 hrs                       $50/month
─────────────────────────────────────────────────────────────────────────────
                                           SUBTOTAL:         $50/month

╔═════════════════════════════════════════════════════════════════════════════╗
║                                                                             ║
║  TOTAL ESTIMATED:                                     ~$1,600/month        ║
║  COST PER VIDEO:                                      ~$1.60/video         ║
║                                                                             ║
╚═════════════════════════════════════════════════════════════════════════════╝

OPTIMIZATION PATHS AT SCALE:
• Self-host SDXL on RunPod: reduces to ~$200/month for images
• S3 Intelligent Tiering: -30% storage costs
• Spot instances for rendering: -60% compute costs
```

---

## 10. Roadmap de Implementación

```
FASE 1: FOUNDATION (Semanas 1-3)
════════════════════════════════════════════════════════════════════════════════

Semana 1: Setup & Auth
├── [ ] Proyecto Next.js + TailwindCSS + shadcn/ui
├── [ ] NestJS API boilerplate
├── [ ] Clerk integration
├── [ ] PostgreSQL + Prisma schema
└── [ ] S3 bucket + CloudFront setup

Semana 2: Core Upload Flow
├── [ ] Audio upload con presigned URLs
├── [ ] Lyrics editor básico
├── [ ] Waveform visualization
├── [ ] Timestamp sync UI
└── [ ] Project CRUD API

Semana 3: Infrastructure
├── [ ] SQS queues setup
├── [ ] Worker containers (ECS)
├── [ ] Redis cache
├── [ ] WebSocket server
└── [ ] CI/CD pipeline

FASE 2: AI PROCESSING (Semanas 4-6)
════════════════════════════════════════════════════════════════════════════════

Semana 4: Language Analysis
├── [ ] spaCy integration
├── [ ] Language detection worker
├── [ ] POS/NER extraction
└── [ ] Literal element extractor

Semana 5: Image Generation
├── [ ] Prompt construction engine
├── [ ] Replicate API integration
├── [ ] Style presets system
├── [ ] Seed management
└── [ ] Quality validation

Semana 6: Video Rendering
├── [ ] FFmpeg motion pipeline
├── [ ] Segment creation
├── [ ] Transitions
├── [ ] Audio merge
└── [ ] Output validation

FASE 3: UX & POLISH (Semanas 7-8)
════════════════════════════════════════════════════════════════════════════════

Semana 7: Frontend Complete
├── [ ] Full wizard flow
├── [ ] Real-time progress updates
├── [ ] Video preview player
├── [ ] History/gallery view
└── [ ] Download functionality

Semana 8: Testing & Launch
├── [ ] E2E testing
├── [ ] Load testing
├── [ ] Security audit
├── [ ] Documentation
└── [ ] Beta launch

POST-MVP ENHANCEMENTS
════════════════════════════════════════════════════════════════════════════════
├── Character consistency (IP-Adapter)
├── Custom style upload
├── Subtitle burn-in option
├── Multiple resolution exports
├── Batch processing
├── API access tier
└── Mobile app
```

---

## 11. Consideraciones de Seguridad

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SECURITY                                        │
└─────────────────────────────────────────────────────────────────────────────┘

AUTHENTICATION & AUTHORIZATION
• JWT tokens via Clerk con expiración corta (15min)
• Refresh token rotation
• Resource-level authorization (solo acceso a proyectos propios)
• Rate limiting: 100 req/min API, 5 generaciones/hora

FILE UPLOAD SECURITY  
• Presigned URLs con expiración de 15min
• Validación de tipo de archivo (magic bytes)
• Max file size: 50MB audio
• Virus scanning (ClamAV)
• S3 bucket sin acceso público

CONTENT MODERATION
• Filtrado de texto de letras para contenido prohibido
• NSFW check en imágenes generadas (built-in FLUX)
• Mecanismo de reporte de usuarios
• Flagging automático para revisión manual

FAILURE HANDLING
• Dead letter queues para mensajes fallidos
• Exponential backoff: 1s, 5s, 30s, 5min
• Max retries: 3 por etapa
• Checkpoint después de cada imagen
• Circuit breakers para APIs externas
```

---

## 12. Decisiones de Diseño Clave

| Decisión | Opción Elegida | Alternativa Descartada | Justificación |
|----------|----------------|------------------------|---------------|
| **Image Gen Model** | FLUX 1.1 Pro | Stable Diffusion, DALL-E | Mejor balance calidad/costo, consistencia superior |
| **NLP Framework** | spaCy | NLTK, Stanza | Más rápido, modelos multiidioma robustos |
| **Queue System** | AWS SQS | RabbitMQ, Kafka | Managed, FIFO ordering, integración nativa AWS |
| **Auth Provider** | Clerk | Auth0, Firebase | Mejor DX, webhooks, pricing competitivo |
| **Video Rendering** | FFmpeg (local) | Cloud video APIs | Control total, sin costos por minuto |
| **Frontend** | Next.js 14 | Remix, SvelteKit | Ecosistema maduro, Vercel optimizado |
| **Backend** | NestJS | Express, Fastify | Estructura modular, TypeScript nativo |

---

## Conclusión

Esta arquitectura está diseñada para:

1. **Literalidad semántica**: Pipeline NLP que extrae solo elementos visualizables, rechazando metáforas
2. **Consistencia visual**: Seed management + style embeddings garantizan coherencia
3. **Escalabilidad**: Event-driven con workers independientes por función
4. **UX transparente**: Feedback en tiempo real, progreso granular, preview integrado
5. **Costo-eficiente**: APIs externas para MVP con path a self-hosting

El MVP puede estar operativo en **8 semanas** con un equipo de 2-3 desarrolladores.
