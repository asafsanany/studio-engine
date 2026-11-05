Write this client’s style. Don’t edit any video: the client’s next edits read what you write.

Client: "{{client}}". The current working directory is the client’s style folder. Every file in it is read-only. Write only style.md.new.

{{modeText}}

New files:
{{files}}

Bash here runs only these commands, one per call, with no pipes, `;`, `&&`, loops, `$( )` or redirects: `ls -la`, `ffprobe -v error -show_entries format=duration -of csv=p=0 "<file>"`, `ffmpeg -v error -y -ss <seconds> -i "<file>" -frames:v 1 /tmp/ref-<n>.jpg` (one frame per call) and `textutil -convert txt -stdout "<file>"`. Anything else is denied. A denial means the form was wrong, not that Bash is off: run it again in one of these forms.

1. Read every new file:
- Text (.txt .md .rtf) as it is. PDFs with the Read tool. .docx and .doc with textutil -convert txt -stdout "<file>".
- Images: look at each one. A logo: note its file name and its colours. A screenshot or a frame from another video: read its look (colours, fonts, how titles and captions are styled).
- Fonts (.ttf .otf .woff .woff2): the family and weight from the file name, with the file name.
- Video: a reference clip. Don’t transcribe it. Get its duration with ffprobe, then make three frames spread across it (the ffmpeg form above, one call per frame, /tmp/ref-1.jpg, /tmp/ref-2.jpg, /tmp/ref-3.jpg; keep counting up if there is more than one clip), look at each with the Read tool and write what to match: title size and position, caption style, pacing, colour.
2. Write style.md.new in this shape:

{{> style-shape}}

Only what the files say or show. Don’t invent brand facts; a colour sampled from a logo is fine, written as “(from the logo)”.

This run is unattended: never ask questions. If a file can’t be read, leave it out and end style.md.new with “Couldn’t read: <file> (<why>)”. You are done when style.md.new exists.
