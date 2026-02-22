---
description: Validate that the video generation pipeline works end-to-end
---

# Task Completion Validator

Use this workflow to verify that a claimed task completion is actually functional.

## Steps

1. **Identify the claimed completion**
   - What feature was supposedly implemented?
   - What is the expected behavior?

2. **Test the full flow**
   - For video generation: Create a new project → Wait for completion → Verify video plays with audio
   - For UI features: Navigate to the page → Perform actions → Verify expected results

3. **Check for stubs or incomplete implementations**
   - Are there TODO comments?
   - Are there hardcoded values that should be dynamic?
   - Are error cases handled?

4. **Verify edge cases**
   - What happens with invalid input?
   - What happens if a service is unavailable?
   - Are there race conditions?

5. **Report findings**
   - List what works
   - List what doesn't work
   - Provide specific steps to reproduce issues

## For Music Video Generator

// turbo-all
```bash
# Quick validation commands
curl http://localhost:3000/api/v1/health
curl http://localhost:3000/api/v1/projects
```

### Full Pipeline Test Checklist
- [ ] Create project with YouTube URL
- [ ] YouTube audio downloads successfully
- [ ] Transcription completes
- [ ] Analysis generates scenes
- [ ] Images generate without errors
- [ ] Video renders with audio
- [ ] Video plays in browser
- [ ] Thumbnail displays during intro
