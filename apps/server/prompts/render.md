Render the approved edit in this folder to edit/final.mp4 with the video-use skill. The owner approved the live preview in edit/preview/, so do not change the edit.

Job: client "{{client}}", job "{{job}}". The footage folder is the current working directory; treat its files as read-only and write everything to ./edit/. {{again}}
- Load the skill, then read edit/project.md.
- Render from edit/preview/: npx hyperframes render -q delivery --strict --no-best-effort -o ../final.mp4
{{> formats-render}}
{{> music-render}}
- Check the render as the Deliverables row of §0 says: H.264, yuv420p, AAC, −14 LUFS and −1 dBTP, and the composition's duration. Look at a frame at every cut with timeline_view. If the loudness is off, fix it with one static gain and a limiter (field notes), never dynamic loudnorm.
- When captions are burned in, copy their SRT to edit/final.srt.
- Fix only what the render itself broke. If the render shows a problem in the edit, do not re-edit: end with the Blocked: line, naming the problem.

{{> final-finish}}

{{> unattended}}
