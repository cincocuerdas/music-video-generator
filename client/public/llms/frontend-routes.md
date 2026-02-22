# Frontend Routes

## `/`

Home page.

- Lists projects.
- Entry point for creating a new project.

## `/create`

Create project flow.

- Accepts source input (e.g., YouTube URL).
- Starts pipeline once project is configured.

## `/project/:id`

Project details and result view.

- Shows processing status during generation.
- Shows final video player when completed.
- Scene thumbnails are clickable and should stay synchronized with video timestamps.

## `/project/:id/director`

Director workflow.

- Scene-level feedback and regeneration controls.
- Used to iterate on weak scenes (anatomy, coherence, prompt fit).
