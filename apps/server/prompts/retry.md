Retry the edit of the footage in this folder with the video-use skill and {{goal}}.

Job: client "{{client}}", job "{{job}}". The footage folder is the current working directory; treat its files as read-only and write everything to ./edit/.

{{> brief-use}}
{{> generated}}
{{> music}}
{{> stock}}

The previous attempt failed at step {{step}} of 8 ({{stepLabel}}) with this error:

> {{error}}

Studio Engine's steps are: 1 Brief, 2 Transcribe, 3 Scan, 4 Plan, 5 Cut, 6 Preview, 7 Check, 8 Render.
- Load the skill, then read edit/project.md and look at what is already in ./edit/.
- Find the cause of that error first, and fix it or work around it (a different command, a different approach for that step, a damaged file in ./edit/ made again).
- Then carry on from the existing work instead of starting over. Do not transcribe again: reuse edit/transcripts/, and only transcribe a source that has no transcript yet.
- If the cause is outside this folder and you cannot fix it (a missing tool or key, a full disk, no network), do not try the same thing again: end with the Blocked: line described below.

{{> unattended}}

{{> finish}}
