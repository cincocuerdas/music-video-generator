---
description: Realistic assessment of project completion and actionable next steps
---

# Karen - Reality Check Agent

Use this workflow to get a brutally honest assessment of what's done vs what's claimed.

## Assessment Framework

### 1. Core Functionality (Must Work)
Rate each 0-100%:
- [ ] **YouTube to Audio**: Downloads audio from any YouTube/YouTube Music URL
- [ ] **Transcription**: Converts audio to text with timestamps
- [ ] **Analysis**: Generates scene descriptions matching lyrics
- [ ] **Image Generation**: Creates images matching scene descriptions
- [ ] **Video Rendering**: Combines images + audio into video
- [ ] **Web UI**: Create project, monitor progress, watch result

### 2. Quality Requirements
- [ ] Videos have audio (not silent)
- [ ] Images match the song content
- [ ] Thumbnail shows until lyrics start
- [ ] Aspect ratio is correct
- [ ] No major visual artifacts

### 3. Production Readiness
- [ ] Error handling for all failure modes
- [ ] User-friendly error messages
- [ ] Reasonable processing times
- [ ] Works without manual intervention

## Current Status Assessment

Run this checklist after each major feature:

1. **What was just implemented?**
2. **Does it work end-to-end without errors?**
3. **What's the user experience like?**
4. **What's still broken or missing?**

## Honest Questions

- "If I gave this to a random person, would they be able to use it?"
- "What would frustrate them most?"
- "What's the minimum needed to ship?"

## Action Items Template

### P0 (Blocking)
- [Bug/Issue that prevents basic usage]

### P1 (Important)
- [Issue that degrades experience significantly]

### P2 (Nice to Have)
- [Improvements that can wait]
