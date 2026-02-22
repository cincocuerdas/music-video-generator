---
description: Perform comprehensive UI testing of the web application
---

# UI Comprehensive Tester

Use this workflow to thoroughly test the React frontend.

## Steps

1. **Start the application**
   - Backend: `npm run start:dev` in `C:\PROJECT`
   - Frontend: `npm run dev` in `C:\PROJECT\client`

2. **Test navigation**
   - Home page loads at http://localhost:5173
   - Create project page accessible
   - Project details page accessible
   - Back navigation works

3. **Test create project flow**
   - Title input accepts text
   - YouTube URL input validates correctly
   - Visual style selector works (all 6 options)
   - Aspect ratio selector works (3 options)
   - Submit button creates project
   - Redirects to project details

4. **Test project details page**
   - Pipeline status shows correctly
   - Status icons update in real-time
   - Video player works when complete
   - Generated images gallery displays
   - WebSocket connection indicator shows

5. **Test home page**
   - Projects list loads
   - Thumbnails display
   - Delete button works with confirmation
   - Project cards link to details

## Browser Test Commands

// turbo
```bash
cd C:\PROJECT\client && npm run dev
```

## Visual Checklist
- [ ] Dark theme renders correctly
- [ ] Buttons have hover states
- [ ] Loading spinners animate
- [ ] Error messages display clearly
- [ ] Responsive on mobile widths
