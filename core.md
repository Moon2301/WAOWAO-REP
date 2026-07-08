# Core Architecture & Workflow Documentation

> **waoowaoo** — AI-powered novel-to-storyboard production platform
> Stack: Next.js 15 (App Router) · TypeScript · Prisma · MySQL · Redis · BullMQ

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [AI Orchestration Architecture](#2-ai-orchestration-architecture)
3. [Task & Queue System](#3-task--queue-system)
4. [Workflow Engine](#4-workflow-engine)
5. [Worker Layer](#5-worker-layer)
6. [Prompt System](#6-prompt-system)
7. [Model Gateway](#7-model-gateway)
8. [Run Runtime](#8-run-runtime)
9. [Key Workflows (End-to-End)](#9-key-workflows-end-to-end)
10. [Infrastructure Startup Sequence](#10-infrastructure-startup-sequence)

---

## 1. System Overview

```
Browser / Client
      │
      ▼
 Next.js App Router
  [API Routes]
   /api/runs          → Create/query workflow runs
   /api/tasks         → Create/query individual tasks
   /api/sse           → Server-Sent Events stream
   /api/projects      → Project CRUD
   /api/assets        → Asset management
   /api/user          → User & API config
      │
      ▼
   MySQL (Prisma)     ← Source of truth for all state
      │
      ▼
   Redis ──────────── BullMQ Job Queues
                        ├── text-queue
                        ├── image-queue
                        ├── video-queue
                        └── voice-queue
                               │
                               ▼
                         Workers (BullMQ)
                          ├── text.worker
                          ├── image.worker
                          ├── video.worker
                          └── voice.worker
                               │
                               ▼
                         Model Gateway
                          ├── LLM (OpenAI-compat APIs)
                          ├── Image (Kling, etc.)
                          ├── Video (Kling, etc.)
                          └── Voice (TTS providers)
```

---

## 2. AI Orchestration Architecture

The platform uses **two-level orchestration**:

### Level 1 — Run Runtime (Workflow-level)
- Manages multi-step **Runs** (e.g., "Story → Script" or "Script → Storyboard")
- A **Run** contains multiple **Tasks** arranged in a dependency graph
- Defined in `src/lib/workflow-engine/registry.ts`

### Level 2 — Task (Atomic AI unit)
- A single BullMQ job executed by a Worker
- Calls one or more LLM / image / video / voice APIs
- Reports progress via Redis SSE stream
- Result is persisted to MySQL

---

## 3. Task & Queue System

### Task Types (`src/lib/task/types.ts`)

| Category | Task Types |
|----------|-----------|
| **Image** | `image_panel`, `image_character`, `image_location`, `panel_variant`, `panel_character_swap`, `asset_hub_image`, `modify_asset_image` |
| **Video** | `video_panel`, `lip_sync`, `video_chunk_split`, `face_swap_chunk`, `video_chunk_merge` |
| **Voice** | `voice_line`, `voice_design`, `asset_hub_voice_design` |
| **Text / LLM** | `story_to_script_run`, `script_to_storyboard_run`, `clips_build`, `screenplay_convert`, `voice_analyze`, `analyze_global`, `analyze_novel`, `ai_story_expand`, `episode_split_llm`, `reference_to_character`, `character_profile_confirm`, `asset_hub_ai_design_character/location`, `asset_hub_ai_modify_*`, `regenerate_storyboard_text`, `insert_panel`, `regenerate_group`, `ai_modify_appearance/location/prop/shot_prompt`, `analyze_shot_variants`, `ai_create_character/location` |

### Queue Routing

```
Task Type              → Queue       → Worker
──────────────────────────────────────────────────
image_*                → image-q    → image.worker.ts
video_*, lip_sync      → video-q    → video.worker.ts
video_chunk_split      → video-q    → video.worker.ts
face_swap_chunk        → video-q    → video.worker.ts
video_chunk_merge      → video-q    → video.worker.ts
voice_*                → voice-q    → voice.worker.ts
everything else        → text-q     → text.worker.ts
```

### Task Lifecycle

```
QUEUED → PROCESSING → COMPLETED
                    ↘ FAILED
                    ↘ CANCELED
                    ↘ DISMISSED
```

Each transition is persisted to MySQL and broadcast via SSE.

---

## 4. Workflow Engine

### Defined Workflows (`src/lib/workflow-engine/registry.ts`)

#### Workflow 1: `story_to_script_run` — Story → Script

```
analyze_characters ──┐
analyze_locations  ──┼──► split_clips ──► screenplay_convert ──► persist_script_artifacts
analyze_props      ──┘
```

- **analyze_characters / locations / props**: Parallel LLM tasks extracting structured data from novel text
- **split_clips**: Splits story into scene clips, depends on all three analyses
- **screenplay_convert**: Converts each clip into screenplay format
- **persist_script_artifacts**: Writes all artifacts to DB

#### Workflow 2: `script_to_storyboard_run` — Script → Storyboard

```
plan_panels ──► detail_panels ──► voice_analyze ──► persist_storyboard_artifacts
```

- **plan_panels**: Phase 1 — LLM plans panel composition for each clip
- **detail_panels**: Phase 2+3 — Cinematography, acting direction, and detail refinement
- **voice_analyze**: Detects dialogue lines, maps to characters
- **persist_storyboard_artifacts**: Writes storyboard to DB

#### Workflow 3: `video_character_swap_run` — Video Face Swap

Replaces character A with character B in a video using Kling AI face-swap API.

```
                     video_chunk_split
                    (FFmpeg: split video
                     into ~10s chunks
                     with 1s overlap +
                     extract audio)
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        face_swap_    face_swap_   face_swap_
        chunk_0       chunk_1      chunk_N
        (Kling API)   (Kling API)  (Kling API)
              │            │            │
              └────────────┼────────────┘
                           ▼
                    video_chunk_merge
                   (FFmpeg: crossfade
                    concat + re-attach
                    original audio)
```

- **video_chunk_split**: Downloads video, uses FFmpeg to split into chunks of ~10s with 1-second overlap, extracts audio track separately. Uses **Option B (handler-driven fan-out)**: upon completion, the handler itself creates N `face_swap_chunk` child tasks and enqueues them to BullMQ. It also pre-creates a `video_chunk_merge` task that depends on all N swap tasks.
- **face_swap_chunk** (×N, dynamic): Each task sends one video chunk + source image (character A) + target image (character B) to Kling face-swap API. Uses async submit→poll pattern via `async-submit.ts` / `async-poll.ts`. Tasks run in parallel (concurrency controlled by BullMQ worker settings).
- **video_chunk_merge**: Waits for all face_swap_chunk tasks to complete. Downloads all swapped chunks, uses FFmpeg crossfade filter to blend overlapping regions, then re-attaches the original audio track. Uploads final video to object storage.

**Dynamic Fan-Out (Option B — Handler-driven)**:
Unlike static workflows, the number of `face_swap_chunk` tasks is unknown until runtime. The `video_chunk_split` handler:
1. Calculates chunk count based on video duration
2. Creates N `face_swap_chunk` task records in MySQL
3. Creates 1 `video_chunk_merge` task record with `dependsOn` = all N swap task IDs
4. Enqueues all N swap tasks to BullMQ video-queue
5. Reports its own task as COMPLETED
6. Run-runtime advances normally — swap tasks complete → merge task unblocks

### Retry Invalidation Logic

When a step is retried, downstream dependent steps are **automatically invalidated** and re-run. For example, retrying `analyze_characters` will also invalidate `split_clips` and all `screenplay_*` steps.

For `video_character_swap_run`: retrying `video_chunk_split` invalidates all `face_swap_chunk` and `video_chunk_merge` tasks. Retrying a single `face_swap_chunk` only re-runs that chunk (merge waits for all).

---

## 5. Worker Layer

### Worker Files

| File | Handles |
|------|---------|
| `src/lib/workers/text.worker.ts` | All LLM/text tasks (~30+ task types) |
| `src/lib/workers/image.worker.ts` | Image generation + panel character swap tasks |
| `src/lib/workers/video.worker.ts` | Video generation + lip sync + face swap + chunk split/merge |
| `src/lib/workers/voice.worker.ts` | TTS voice synthesis |

### Worker Entry Point

`src/lib/workers/index.ts` bootstraps all four BullMQ workers on server startup.

### Key Handler Files (`src/lib/workers/handlers/`)

| Handler | Task |
|---------|------|
| `story-to-script.ts` | Orchestrates the full Story→Script workflow steps |
| `script-to-storyboard.ts` | Orchestrates Script→Storyboard phases |
| `analyze-novel.ts` | Novel analysis (character/location/prop extraction) |
| `analyze-global.ts` | Global asset analysis across episodes |
| `clips-build.ts` | Clip splitting and assignment |
| `screenplay-convert.ts` | Per-clip screenplay conversion |
| `voice-analyze.ts` | Voice line detection and character mapping |
| `episode-split.ts` | LLM-based episode splitting |
| `reference-to-character.ts` | Image reference → character description |
| `character-profile.ts` | Character profile confirmation |
| `shot-ai-tasks.ts` | AI shot modification (appearance, location, prop, shot prompt) |
| `asset-hub-ai-design.ts` | AI asset design for characters/locations |
| `asset-hub-ai-modify.ts` | AI-guided asset modification |
| `ai-story-expand.ts` | AI-assisted story expansion |
| `video-chunk-split.ts` | FFmpeg video splitting into timed chunks with overlap |
| `face-swap-chunk.ts` | Kling AI face-swap API call for a single video chunk |
| `video-chunk-merge.ts` | FFmpeg crossfade concat + audio re-attachment |
| `panel-character-swap.ts` | **[NEW]** Redraw storyboard panel with swapped character using NP_SINGLE_PANEL_IMAGE |
| `llm-stream.ts` | Shared streaming LLM invocation helper |

### LLM Streaming in Workers

Workers use an internal callback system to stream LLM output chunks directly to Redis, which are then pushed to the client via SSE:

```
text.worker.ts
  └─ createWorkerLLMStreamCallbacks()
       └─ chunk arrives → reportTaskStreamChunk() → Redis pub → SSE → Client
```

---

## 6. Prompt System

### Architecture

Prompts are stored as `.txt` files and loaded at runtime with i18n support (English `en` / Chinese `zh`).

```
lib/prompts/
  ├── character-reference/
  │   ├── character_image_to_description.en.txt
  │   ├── character_image_to_description.zh.txt
  │   ├── character_reference_to_sheet.en.txt
  │   └── character_reference_to_sheet.zh.txt
  ├── novel-promotion/
  │   ├── agent_clip.en.txt / .zh.txt
  │   ├── agent_storyboard_plan.en.txt / .zh.txt
  │   ├── agent_cinematographer.en.txt / .zh.txt
  │   ├── agent_acting_direction.en.txt / .zh.txt
  │   ├── agent_storyboard_detail.en.txt / .zh.txt
  │   ├── agent_character_profile.en.txt / .zh.txt
  │   ├── agent_character_visual.en.txt / .zh.txt
  │   ├── screenplay_conversion.en.txt / .zh.txt
  │   ├── voice_analysis.en.txt / .zh.txt
  │   └── ... (30+ prompts)
  └── skills/
      ├── api-config-template.system.txt  (API config assistant)
      └── tutorial.system.txt             (Tutorial assistant)
```

### Prompt IDs (`src/lib/prompt-i18n/prompt-ids.ts`)

| Prompt ID | Purpose |
|-----------|---------|
| `character_image_to_description` | Vision: image → character description |
| `character_reference_to_sheet` | Reference image → character sheet |
| `np_agent_clip` | Clip analysis agent |
| `np_agent_storyboard_plan` | Phase 1: panel planning |
| `np_agent_cinematographer` | Phase 2a: cinematography direction |
| `np_agent_acting_direction` | Phase 2b: acting direction |
| `np_agent_storyboard_detail` | Phase 3: detail refinement |
| `np_agent_character_profile` | Character profile extraction |
| `np_agent_character_visual` | Character visual description |
| `np_agent_shot_variant_analysis` | Shot variant analysis |
| `np_agent_shot_variant_generate` | Shot variant generation |
| `np_agent_storyboard_insert` | Panel insertion between two panels |
| `np_screenplay_conversion` | Clip → screenplay conversion |
| `np_voice_analysis` | Voice line detection |
| `np_episode_split` | Episode boundary detection |
| `np_character_create/modify/regenerate` | Character asset operations |
| `np_location_create/modify/regenerate` | Location asset operations |
| `np_image_prompt_modify` | Image prompt editing |
| `np_ai_story_expand` | Story expansion |
| `np_storyboard_edit` | Storyboard panel editing |
| `np_single_panel_image` | Single panel image prompt |
| `np_select_prop/location` | Asset selection helpers |
| `*_description_update` | Description sync after image generation |

### How Prompts Are Loaded

```typescript
// src/lib/prompt-i18n/build-prompt.ts
const prompt = await buildPrompt(PROMPT_IDS.NP_AGENT_STORYBOARD_PLAN, locale, {
  characters_lib_name: '...',
  clip_json: '...',
  clip_content: '...',
  // ... other variables from catalog
})
// Loads: lib/prompts/novel-promotion/agent_storyboard_plan.{locale}.txt
// Replaces: {{variable_name}} placeholders with actual values
```

### Special: Skills Prompts

The `lib/prompts/skills/` directory holds system prompts for in-app AI assistants ("skills"):

- **`api-config-template.system.txt`**: Guides users through configuring 3rd-party image/video API providers. Enforces strict template schema with validation rules (see Section 7).
- **`tutorial.system.txt`**: Tutorial assistant for new users.

---

## 7. Model Gateway

Located in `src/lib/model-gateway/`

### Text / LLM (`model-gateway/llm.ts`)

```
runModelGatewayTextCompletion(input)
  └─ router.ts → selects provider based on model config
  └─ openai-compat/ → sends request via OpenAI-compatible API
  └─ returns: OpenAI.Chat.Completions.ChatCompletion
```

Also supports vision via `runModelGatewayVisionCompletion()` (image URL input).

### Image / Video

Routes through `src/lib/async-poll.ts` and `src/lib/async-submit.ts` for async API patterns:
- **Submit**: POST to provider API → get task ID
- **Poll**: GET status until done → fetch result URL

### Provider Configuration

Users configure their own API providers via **Profile > API Settings**. Configuration is stored in DB and loaded via `src/lib/config-service.ts`. The `api-config-template` skill assists with setup.

### API Config Template Schema

```json
{
  "version": 1,
  "mediaType": "image" | "video",
  "mode": "sync" | "async",
  "create": {
    "method": "POST",
    "path": "/v1/generate",
    "bodyTemplate": {
      "model": "{{model}}",
      "prompt": "{{prompt}}"
    }
  },
  "status": { "method": "GET", "path": "/v1/tasks/{{task_id}}" },
  "response": {
    "taskIdPath": "$.data.task_id",
    "statusPath": "$.data.status",
    "outputUrlPath": "$.data.url"
  },
  "polling": {
    "intervalMs": 5000,
    "timeoutMs": 600000,
    "doneStates": ["completed"],
    "failStates": ["failed", "error"]
  }
}
```

### Kling Face Swap API Config

Specialized config for the Kling AI video face-swap endpoint used by `face_swap_chunk` tasks:

```json
{
  "version": 1,
  "mediaType": "video",
  "mode": "async",
  "create": {
    "method": "POST",
    "path": "/v1/videos/face-swap",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{api_key}}"
    },
    "bodyTemplate": {
      "model_name": "kling-v2",
      "face_image_url": "{{target_face_url}}",
      "target_video_url": "{{chunk_video_url}}",
      "reference_image_url": "{{source_face_url}}"
    }
  },
  "status": {
    "method": "GET",
    "path": "/v1/videos/face-swap/{{task_id}}",
    "headers": {
      "Authorization": "Bearer {{api_key}}"
    }
  },
  "response": {
    "taskIdPath": "$.data.task_id",
    "statusPath": "$.data.task_status",
    "outputUrlPath": "$.data.task_result.videos[0].url",
    "statusMapping": {
      "submitted": "pending",
      "processing": "processing",
      "succeed": "completed",
      "failed": "failed"
    }
  },
  "polling": {
    "intervalMs": 5000,
    "timeoutMs": 600000,
    "doneStates": ["succeed"],
    "failStates": ["failed"]
  }
}
```

> **Note**: `face_image_url` = character B (the face to put IN), `reference_image_url` = character A (the face to find/match in the video), `target_video_url` = the video chunk to process.

---

## 8. Run Runtime

Located in `src/lib/run-runtime/`

### Run Lifecycle

```
POST /api/runs
  └─ createRun() [service.ts]
       ├─ Creates Run record in MySQL (status: QUEUED)
       ├─ Resolves workflow definition from registry
       ├─ Creates all Task records for run steps
       └─ Enqueues initial tasks (no dependencies) to BullMQ
            │
            ▼
       Workers execute tasks
            │
            ▼
       task-bridge.ts → notifies run-runtime when task completes/fails
            │
            ▼
       run-runtime/service.ts → advances workflow:
            ├─ Marks completed steps
            ├─ Checks if dependent steps are now unblocked
            ├─ Enqueues newly unblocked tasks
            └─ Updates Run status
```

### Run Status Flow

```
QUEUED → RUNNING → COMPLETED
                 ↘ FAILED
                 ↘ CANCELING → CANCELED
```

### Reconciliation (`src/lib/run-runtime/reconcile.ts`)

Detects and recovers orphaned tasks: tasks with `queued` DB status that have no corresponding BullMQ job (e.g., after Redis restart).

### Task Watchdog (`src/lib/task/reconcile.ts`)

Started at server boot, runs continuously:
1. Resets `processing` tasks that timed out → back to `queued`
2. Re-enqueues `queued` tasks that lost their BullMQ job

---

## 9. Key Workflows (End-to-End)

### A. Full Pipeline: Novel → Storyboard

```
User uploads novel text
        │
        ▼
[Frontend] POST /api/runs { workflowType: 'story_to_script_run' }
        │
        ▼
[Run Runtime] Creates Run + Tasks in DB:
  - Task: analyze_characters  ← queued immediately
  - Task: analyze_locations   ← queued immediately
  - Task: analyze_props       ← queued immediately
  - Task: split_clips         ← waiting for above 3
  - Task: screenplay_convert  ← waiting for split_clips
  - Task: persist_artifacts   ← waiting for convert
        │
        ▼
[BullMQ text-queue] → text.worker picks up jobs
  For each task:
    1. Load locale-specific prompt template
    2. Fill in variables from DB context
    3. Call LLM via Model Gateway
    4. Stream output chunks → Redis → SSE → Client
    5. Parse JSON result from LLM response
    6. Persist artifacts to MySQL
    7. Notify run-runtime (task-bridge)
        │
        ▼
[Run Runtime] Advances workflow, queues next tasks
        │
        ▼
After story_to_script completes:
[Frontend] POST /api/runs { workflowType: 'script_to_storyboard_run' }
        │
        ▼
[Run Runtime] Creates Storyboard Tasks:
  - Task: plan_panels    (Phase 1 per clip)
  - Task: detail_panels  (Phase 2+3 per clip)
  - Task: voice_analyze
  - Task: persist_storyboard_artifacts
```

### B. Image Generation

```
User clicks "Generate Image" for a panel
        │
        ▼
[Frontend] POST /api/tasks { type: 'image_panel', targetId: panelId }
        │
        ▼
[BullMQ image-queue] → image.worker
  1. Load panel storyboard data from DB
  2. Build image prompt from storyboard text + style
  3. Submit to image provider API
  4. Poll until result available (async mode)
  5. Download image → upload to object storage
  6. Update panel record with image URL
  7. Report task COMPLETED
        │
        ▼
[SSE] Client receives update, renders image in panel
```

### C. Reference Image → Character Profile

```
User uploads a character reference image
        │
        ▼
POST /api/tasks { type: 'reference_to_character', payload: { imageUrl } }
        │
        ▼
text.worker → handlers/reference-to-character.ts
  Step 1: Vision LLM call with prompt CHARACTER_IMAGE_TO_DESCRIPTION
          → Extracts character description from image
  Step 2: LLM call with prompt CHARACTER_REFERENCE_TO_SHEET
          → Structures description into character sheet format
  Step 3: Save character profile to DB
```

### D. Storyboard Phase Details

Each clip goes through 4 phases during `script_to_storyboard_run`:

| Phase | Prompt Used | What It Does |
|-------|-------------|--------------|
| Phase 1 | `np_agent_storyboard_plan` | Plans panel count and rough descriptions |
| Phase 2a | `np_agent_cinematographer` | Assigns shot types, camera moves, locations |
| Phase 2b | `np_agent_acting_direction` | Adds character acting/expression direction |
| Phase 3 | `np_agent_storyboard_detail` | Refines visual details, lighting, atmosphere |

### E. Storyboard Panel — Character Swap (ảnh tĩnh)

Workflow mới — thay thế nhân vật trong 1 panel storyboard, giữ nguyên bố cục/góc máy/cảnh.

```
User chọn panel + nhân vật cũ + nhân vật mới
        │
        ▼
[Frontend] POST /api/tasks {
  type: 'panel_character_swap',
  targetId: panelId,
  payload: {
    panelId,
    fromCharacterName,   // nhân vật bị thay
    toCharacterName,     // nhân vật thay vào
    toAppearanceName,    // (optional) appearance cụ thể
  }
}
        │
        ▼
[BullMQ image-queue] → image.worker
  handlers/panel-character-swap.ts:
    1. Load panel từ DB (description, shotType, characters, location...)
    2. Load projectData (characters list với appearances)
    3. Validate toCharacter tồn tại trong project
    4. swapCharacterInList(): thay fromChar → toChar trong JSON characters của panel
    5. Build NP_SINGLE_PANEL_IMAGE prompt với:
       - context JSON đã swap character
       - style instruction = keepLayoutHint + artStyle
         "Keep same composition/framing/angle/background. Only replace [from] with [to]."
    6. Collect reference images:
       [1] Ảnh panel gốc (layout anchor — quan trọng nhất)
       [2] Ảnh appearance của nhân vật mới (để AI biết nhân vật mới trông như thế nào)
       [3] Ảnh location (optional)
    7. Generate image via Model Gateway (image provider)
    8. Upload kết quả → object storage
    9. Persist (Option A):
       candidateImages = [newImage, ...existingCandidates]
       (KHÔNG overwrite imageUrl — user phải review trước)
        │
        ▼
[SSE] Client nhận update, hiển thị ảnh mới trong tab candidateImages
User click "Accept" → apply vào imageUrl
User click "Discard" → giữ ảnh cũ
```

**Điểm khác biệt so với `panel_variant`:**

| | `panel_variant` | `panel_character_swap` |
|-|-----------------|------------------------|
| Mục đích | Thay đổi góc máy/shot type | Thay thế nhân vật, giữ bố cục |
| Characters | Dùng characters gốc của panel | Swap character trong context |
| Reference | ảnh panel gốc + chars + location | **ảnh panel gốc** (layout) + **ảnh nhân vật mới** |
| Prompt | `NP_AGENT_SHOT_VARIANT_GENERATE` | `NP_SINGLE_PANEL_IMAGE` + layout hint |
| Kết quả | Candidate với shot khác | Candidate với nhân vật khác |

### F. Video Character Swap (Face Swap)

```
User uploads:
  - Image A (source character face)
  - Image B (target character face — replacement)
  - Video (contains character A)
        │
        ▼
[Frontend] POST /api/runs {
  workflowType: 'video_character_swap_run',
  payload: {
    sourceImageUrl: '...character-a.jpg',
    targetImageUrl: '...character-b.jpg',
    videoUrl: '...original-video.mp4',
    chunkDurationSec: 10,        // default 10
    chunkOverlapSec: 1           // default 1
  }
}
        │
        ▼
[Run Runtime] Creates Run + initial Task in DB:
  - Task: video_chunk_split  ← queued immediately
  (face_swap_chunk × N and video_chunk_merge are NOT created yet;
   they will be created dynamically by the split handler)
        │
        ▼
[BullMQ video-queue] → video.worker picks up video_chunk_split
  handlers/video-chunk-split.ts:
    1. Download video from object storage → temp dir
    2. FFmpeg probe → get total duration (e.g., 35 seconds)
    3. Calculate chunks with overlap:
       chunkDuration = 10s, overlap = 1s
       Chunk 0:  0.0s – 10.0s
       Chunk 1:  9.0s – 19.0s   (1s overlap with chunk 0)
       Chunk 2: 18.0s – 28.0s   (1s overlap with chunk 1)
       Chunk 3: 27.0s – 35.0s   (1s overlap with chunk 2)
    4. FFmpeg split with precise seeking:
       ffmpeg -i input.mp4 -ss {start} -to {end}
              -c:v libx264 -c:a aac chunk_{i}.mp4
    5. Extract audio (preserved separately):
       ffmpeg -i input.mp4 -vn -c:a copy audio_original.aac
    6. Upload all chunks + audio → object storage
    7. ── DYNAMIC FAN-OUT (Option B) ──
       Create N face_swap_chunk tasks in MySQL:
         for each chunk[i]:
           createTask({
             runId,
             type: 'face_swap_chunk',
             payload: {
               chunkIndex: i,
               chunkVideoUrl: chunk[i].url,
               sourceImageUrl: payload.sourceImageUrl,
               targetImageUrl: payload.targetImageUrl,
               startTime: chunk[i].start,
               endTime: chunk[i].end
             }
           })
       Create 1 video_chunk_merge task in MySQL:
         createTask({
           runId,
           type: 'video_chunk_merge',
           status: 'queued_waiting',  // special: won't be picked up yet
           payload: {
             totalChunks: N,
             audioUrl: audio_original_url,
             overlapSec: 1,
             originalDuration: 35
           },
           dependsOn: [all N swap task IDs]
         })
       Enqueue all N swap tasks → BullMQ video-queue
    8. Report video_chunk_split as COMPLETED
        │
        ▼
[BullMQ video-queue] → video.worker picks up face_swap_chunk × N (parallel)
  handlers/face-swap-chunk.ts (for each chunk):
    1. Load Kling face-swap API config from config-service
    2. Submit to Kling API (async-submit.ts):
       POST /v1/videos/face-swap {
         model_name: 'kling-v2',
         face_image_url: targetImageUrl,      // Character B face
         target_video_url: chunkVideoUrl,     // Video chunk to process
         reference_image_url: sourceImageUrl  // Character A face (to find)
       }
    3. Poll until done (async-poll.ts):
       GET /v1/videos/face-swap/{task_id}
       → Wait for task_status = 'succeed'
    4. Download swapped chunk → upload to object storage
    5. Save result: { swappedChunkUrl, chunkIndex } to task output
    6. Report task COMPLETED
    7. task-bridge.ts notifies run-runtime
        │
        ▼
[Run Runtime] After ALL face_swap_chunk tasks complete:
  Unblocks video_chunk_merge → enqueues to BullMQ
        │
        ▼
[BullMQ video-queue] → video.worker picks up video_chunk_merge
  handlers/video-chunk-merge.ts:
    1. Fetch all completed face_swap_chunk task outputs from DB
    2. Sort by chunkIndex
    3. Download all swapped chunks → temp dir
    4. FFmpeg crossfade concat (blend 1s overlapping regions):
       ffmpeg -i chunk_0.mp4 -i chunk_1.mp4 -i chunk_2.mp4 ...
              -filter_complex "
                [0][1]xfade=transition=fade:duration=1:offset=9,
                [2]xfade=transition=fade:duration=1:offset=18,
                ..." 
              -map "[video]" merged_video_only.mp4
    5. Re-attach original audio:
       ffmpeg -i merged_video_only.mp4 -i audio_original.aac
              -c:v copy -c:a copy -map 0:v -map 1:a
              -shortest final_output.mp4
    6. Upload final video → object storage
    7. Create/update asset record in MySQL with final video URL
    8. Report task COMPLETED
        │
        ▼
[SSE] Client receives final update, renders swapped video
```

#### Chunk Overlap & Crossfade Strategy

| Parameter | Default | Purpose |
|-----------|---------|---------||
| `chunkDurationSec` | 10 | Base duration of each video chunk |
| `chunkOverlapSec` | 1 | Overlap between adjacent chunks to avoid hard cuts |
| Crossfade | `xfade=transition=fade:duration=1` | FFmpeg filter to blend overlapping regions smoothly |

Example for a 35-second video with 10s chunks and 1s overlap:

| Chunk | Time Range | Effective After Merge |
|-------|------------|-----------------------|
| 0 | 0.0 – 10.0s | 0.0 – 9.5s |
| 1 | 9.0 – 19.0s | 9.5 – 18.5s |
| 2 | 18.0 – 28.0s | 18.5 – 27.5s |
| 3 | 27.0 – 35.0s | 27.5 – 35.0s |

---

## 10. Infrastructure Startup Sequence

When Next.js server boots (`src/instrumentation.ts`):

```
Server Start
  │
  ├─ [Phase 1] Reset stuck tasks (crash recovery)
  │    └─ UPDATE task SET status='queued', startedAt=NULL
  │       WHERE status='processing'
  │
  ├─ [Phase 2] Re-enqueue orphaned tasks (Redis restart recovery)
  │    └─ SELECT * FROM task WHERE status='queued'
  │    └─ For each → addTaskJob(jobData) → BullMQ
  │
  └─ [Phase 3] Start Task Watchdog (ongoing health check)
       └─ startTaskWatchdog() → periodic reconciliation loop
```

### Docker Services

| Service | Role | Port |
|---------|------|------|
| `app` | Next.js (API + Frontend + Workers) | 3000 (internal) |
| `mysql` | Primary database (Prisma ORM) | 3306 (internal) |
| `redis` | BullMQ queues + SSE pub/sub | 6379 (internal) |
| `caddy` | Reverse proxy with HTTPS | 80, 443 |

---

## Key Source Files Reference

| File | Purpose |
|------|---------|
| `src/lib/task/types.ts` | All task type constants and TypeScript types |
| `src/lib/task/queues.ts` | BullMQ queue definitions and job submission |
| `src/lib/task/service.ts` | Task CRUD and DB operations |
| `src/lib/task/reconcile.ts` | Task watchdog / health check loop |
| `src/lib/workflow-engine/registry.ts` | Workflow step definitions and dependency graph |
| `src/lib/run-runtime/service.ts` | Run orchestration and advancement logic |
| `src/lib/run-runtime/task-bridge.ts` | Worker → Run Runtime notification bridge |
| `src/lib/run-runtime/reconcile.ts` | Run-level orphan task recovery |
| `src/lib/workers/text.worker.ts` | Main LLM worker (30+ task types) |
| `src/lib/workers/image.worker.ts` | Image generation worker |
| `src/lib/workers/video.worker.ts` | Video generation + lip sync + face swap + chunk split/merge worker |
| `src/lib/workers/voice.worker.ts` | TTS voice synthesis worker |
| `src/lib/workers/shared.ts` | Shared worker utilities (lifecycle, progress reporting) |
| `src/lib/workers/handlers/video-chunk-split.ts` | FFmpeg video chunking with overlap + dynamic fan-out |
| `src/lib/workers/handlers/face-swap-chunk.ts` | Kling face-swap API call for single video chunk |
| `src/lib/workers/handlers/video-chunk-merge.ts` | FFmpeg crossfade concat + audio re-attachment |
| `src/lib/model-gateway/llm.ts` | LLM provider routing and invocation |
| `src/lib/model-gateway/router.ts` | Multi-provider routing logic |
| `src/lib/prompt-i18n/catalog.ts` | Prompt ID → file path mapping |
| `src/lib/prompt-i18n/prompt-ids.ts` | Prompt ID enum constants |
| `src/lib/prompt-i18n/build-prompt.ts` | Prompt template loading and variable substitution |
| `src/lib/config-service.ts` | API provider config loading from DB |
| `src/lib/ai-runtime/client.ts` | High-level AI step execution (text + vision) |
| `src/instrumentation.ts` | Server boot / startup recovery logic |
| `lib/prompts/skills/api-config-template.system.txt` | API config assistant system prompt |
