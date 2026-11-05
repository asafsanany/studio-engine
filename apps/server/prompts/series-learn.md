Write the format of a series from this finished episode, so the next episodes are rebuilt from it. Don’t edit any video.

Client "{{client}}", series "{{series}}", episode "{{job}}". The current working directory is the episode’s folder. Every file in it is read-only. Write only {{seriesDir}}/series.md.new{{styleTarget}}.

Bash here runs only these commands, one per call, with no pipes, `;`, `&&`, loops, `$( )` or redirects: `ls -la "<folder>"`, `ffprobe -v error -show_entries format=duration -of csv=p=0 edit/final.mp4` and `ffmpeg -v error -y -ss <seconds> -i edit/final.mp4 -frames:v 1 /tmp/series-<n>.jpg` (one frame per call). Anything else is denied. A denial means the form was wrong, not that Bash is off: run it again in one of these forms. Read files with the Read, Glob and Grep tools.

1. Read edit/project.md (the editor’s plan) and edit/brief.md if it exists.
2. Read the composition copied into {{seriesDir}}/kit/: index.html and every compositions/*.html. Note each graphic’s font, weight, size, colour, position and timing, and every music and sound cue. A graphic mounted from compositions/lib-<id>.html is not in the kit (see Library graphics below).
3. Look at four frames of edit/final.mp4 (ffmpeg -ss <10%, 30%, 60% and 90% of its duration> -i edit/final.mp4 -frames:v 1 /tmp/series-<n>.jpg) and check them against what you read.
4. Write {{seriesDir}}/series.md.new in this shape, with “Format from {{job}} ({{date}}).” as the line under the title:

{{> series-shape}}
{{step5}}

{{notes}}

Only what the episode and its files show. Under “New in each episode” list every part of the video that must change from one episode to the next (on-screen text from the brief, the footage, captions from the speech) and say where each one comes from.

Library graphics. A graphic mounted in index.html from compositions/lib-<id>.html (<id> is 12 hex characters) is from the owner’s Graphics library, not the format’s own. Its files are not in the kit, and each episode takes the library’s current version from its own edit/graphics/<id>/. Never describe its look, whatever the frames show. Under “Same in every episode” write one line for it, in the library graphic form of the shape: its name, its folder and when it plays (the mount’s data-start). Its text fields are new in each episode, so list them under “New in each episode” with where each comes from. Its name is the name in the episode’s edit/graphics/<id>/about.json, or the one in the Graphics library section of edit/brief.md; if neither has it, write <id>.

This run is unattended: never ask questions. You are done when {{doneFiles}} exist.
