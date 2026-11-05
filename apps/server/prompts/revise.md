Apply the owner's review notes to the edit in this folder with the video-use skill, and finish it again as a live preview in edit/preview/.

Job: client "{{client}}", job "{{job}}". The footage folder is the current working directory; treat its files as read-only and write everything to ./edit/.

{{> brief-use}}

This is review round {{round}}. The owner watched the preview in edit/preview/ and wrote their notes in edit/review/round-{{round}}.md. Each note is pinned to a moment on the preview's timeline (m:ss.s). A voice note comes with its transcript; its audio file is listed next to it in case the transcript is missing or the tone matters. {{again}}
- Load the skill, then read edit/review/round-{{round}}.md, edit/project.md and the composition in edit/preview/ before anything else.
- Do not transcribe the footage again and do not start over: change the existing edit.
- Do what each note asks and nothing else. Every other decision (cuts, look, graphics, captions, music) stays as it is.
{{> luts-use}}
{{> music-revise}}
{{> generate-revise}}
{{> stock-revise}}
- A note that is unclear: take the most likely reading. A note that is impossible or goes against the brief: do the closest thing that works.
- A voice note without a transcript: transcribe it with ~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/transcribe.py "<file>" --edit-dir "./edit/review/voice".
- Add a section "## Round {{round}}" at the end of project.md with one line per note: what you changed, or why you did something else.

{{> preview-finish}}

{{> unattended}}
