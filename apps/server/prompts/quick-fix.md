The owner is watching the live preview of this edit in Studio Engine and asked for one change at {{time}} on its timeline:
<note>
{{note}}
</note>
Make it now, in the composition only; they see it as soon as you finish.

Job: client "{{client}}", job "{{job}}". The current working directory is the job folder. Everything you need is in ./edit/; there is no skill to load and no footage to open.

Bash here runs only these commands, one per call, never after a `cd` and never joined with `&&` or `;`: `npx hyperframes lint edit/preview`, `npx hyperframes snapshot edit/preview …` as written below, `ls`, `mkdir -p edit/preview/assets/fonts` and `cp edit/fonts/<file> edit/preview/assets/fonts/`. A path with a space in it, like the folder "Hebrew + English", goes in double quotes (`ls "edit/fonts/Hebrew + English"`, `cp "edit/fonts/Hebrew + English/Heebo/Heebo-Bold.ttf" edit/preview/assets/fonts/`), never with backslashes. Anything else is denied. A denial means the form was wrong, not that Bash is off: run it again in one of these forms.

- Read edit/project.md and the composition in edit/preview/ (index.html and the sub-compositions it loads). Captions and titles carry data-timeline-role marks.
- Before you change anything, snapshot {{time}} and look at it: `npx hyperframes snapshot edit/preview --at={{at}} --no-end --keep -o {{fixDir}}/stills/before`, then read the PNG it lists.
- Change only the composition's HTML, CSS, JS and JSON in edit/preview/. Never touch cut.mp4, the music, the clips or any other media, and do not render.
- Do what the note asks and nothing else; every other caption, title, graphic and timing stays as it is. A note that is unclear: take the most likely reading.
- A font: The owner's fonts are in edit/fonts/ (`ls edit/fonts`); a note names one with an @ and its full name, like @Heebo Bold. To use one, copy its file into edit/preview/assets/fonts/ and load it with @font-face from that relative path, and check it has the letters of the text: a font without Hebrew letters is never used for Hebrew words (keep the font those words have now and change only the Latin ones).
- If it can't be done in the composition alone (another shot, a re-cut, a new grade, new music, or the text is part of the footage), change nothing and say why.
{{> composition-rules}}
- Check: `npx hyperframes lint edit/preview` with 0 errors; then `npx hyperframes snapshot edit/preview --at={{at}} --no-end --keep -o {{fixDir}}/stills/after`, and one snapshot at the start and one at the end of each element you changed (`--at=<start>,<end> --no-end --keep -o {{fixDir}}/stills/frames`), and look at them.
- Add one line under "## Round {{round}} · fixed in Review" at the end of edit/project.md (add the heading if it is missing): what you changed.
- Finish with {{fixDir}}/reply.json: {"done": true, "said": "<one short sentence for the owner, e.g. The captions are Heebo Bold now.>"} or, when you changed nothing, {"done": false, "why": "<a few words, e.g. the sign is part of the footage>"}.

This run is unattended (Studio Engine): nobody will answer questions, so never ask any; decide on judgment. Read only this folder: the client's style, the series and the shared fonts are already copied into edit/style/, edit/series/ and edit/fonts/, so don't open the client's other folders or anything else in the inbox. Never write outside edit/preview/, edit/project.md and {{fixDir}}/. Do not leave anything running in the background when you finish. You are done when {{fixDir}}/reply.json is written.
