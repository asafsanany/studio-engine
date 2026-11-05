Continue the edit of the footage in this folder with the video-use skill and {{goal}}.

Job: client "{{client}}", job "{{job}}". The footage folder is the current working directory; treat its files as read-only and write everything to ./edit/.

{{> brief-use}}
{{> generated}}
{{> music}}
{{> stock}}

An earlier run on this job was stopped partway, at step {{step}} of 8 ({{stepLabel}}). Studio Engine's steps are: 1 Brief, 2 Transcribe, 3 Scan, 4 Plan, 5 Cut, 6 Preview, 7 Check, 8 Render. Its work is in ./edit/, so carry on from there instead of starting over:
- Load the skill, then read edit/project.md and look at what is already in ./edit/ before doing anything else.
- Do not transcribe again: reuse edit/transcripts/. Only transcribe a source that has no transcript yet.
- Keep the decisions already in edit/project.md unless one of them is clearly broken.
- Redo only what is missing or was cut off. A file being written when the run stopped (a render, a .prenorm.mp4, a half-written final.mp4) may be incomplete: check it, and make it again if it is.

{{> unattended}}

{{> finish}}
