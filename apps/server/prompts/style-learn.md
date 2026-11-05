Write the style of this finished video, so the client’s next videos match it. Don’t edit any video.

Client "{{client}}", job "{{job}}". The current working directory is the job folder. Every file in it is read-only. Write only {{styleDir}}/style.md.new.

Bash here runs only these commands, one per call, with no pipes, `;`, `&&`, loops, `$( )` or redirects: `ls -la "<folder>"`, `ffprobe -v error -show_entries format=duration -of csv=p=0 edit/final.mp4` and `ffmpeg -v error -y -ss <seconds> -i edit/final.mp4 -frames:v 1 /tmp/learn-<n>.jpg` (one frame per call). Anything else is denied. A denial means the form was wrong, not that Bash is off: run it again in one of these forms. Read files with the Read, Glob and Grep tools.

1. Read edit/project.md (the editor’s plan and the look it chose), and edit/brief.md if it exists.
2. Read the graphics the edit used: every edit/animations/slot_*/index.html and compositions/*.html, except the library graphics (see Library graphics below). Note the fonts, weights, colours, sizes and positions.
3. Look at four frames of edit/final.mp4: get its duration with ffprobe, work out 10%, 30%, 60% and 90% of it, make one frame at each time (the ffmpeg form above, one call per frame, /tmp/learn-1.jpg to /tmp/learn-4.jpg), look at each with the Read tool and check the titles, lower thirds and captions against what you read.
4. These graphics were copied into {{styleDir}}/kit/: {{kit}}. Name each one under ## Kit (title card, lower third, captions, end card, …). Library graphics are not in kit/, so none is named there.
{{step5}}

{{> style-shape}}

Only what the video and its files show. Do and Don’t come only from edit/brief.md, never from your own taste.

Library graphics. A compositions/lib-<id>.html (<id> is 12 hex characters, with a lib/<id>/ folder) is a graphic from the owner’s Graphics library, not the client’s own. It is not in kit/, and the next job takes its current version from the library. Never describe its look, whatever its files and the frames show. Write one line for it under ## Look, on the line of its kind (Lower thirds, Titles, …; add a line when the kind has none), naming it and when it played in this video, for example “Lower thirds: the library’s Name on a white pill, the first time a person is named”. Its name is the name in edit/graphics/<id>/about.json, or the one in the Graphics library section of edit/brief.md; if neither has it, write <id>. When it played comes from its mount in index.html (data-start) and what is said then.

This run is unattended: never ask questions. You are done when {{styleDir}}/style.md.new exists.
