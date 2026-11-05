Write the brief for this edit. Don’t edit any video: a separate run does that after you, and it reads your brief first.

Job: client "{{client}}", job "{{job}}". The job folder is the current working directory. Every file in it is read-only. Write only edit/brief.json, plus voice-note transcripts under edit/brief/.
{{> episode}}

The owner runs the studio. Their note for this job beats everything else, the client included:
<note>
{{note}}
</note>

1. The files are listed below (edit/ and dotfiles left out) with each file’s kind, size and modified time, and the duration of every video and audio file. You don’t need to list the folder or ffprobe anything yourself.
{{files}}

Bash here runs only these commands, one per call, with no pipes, `;`, `&&`, redirects, `find` or `xargs`: `ls -la`, `ffprobe -v error -show_entries format=duration -of csv=p=0 "<file>"`, `textutil -convert txt -stdout "<file>"` and the transcribe command in step 2. Anything else is denied. A denial means the form was wrong, not that Bash is off: run it again in one of these forms.

2. Read every file that can carry instructions:
- Text: .txt .md .rtf as they are. .pdf with the Read tool. .docx .doc with textutil -convert txt -stdout "<file>". For .pages, read QuickLook/Preview.pdf inside the package.
- WhatsApp exports (_chat.txt, "WhatsApp Chat - … .txt"): every message in order, with its date and sender. An <attached: …> line ties a voice note or photo to its message.
- Voice notes and short audio (.opus .ogg .m4a .amr, or any audio under 5 minutes that isn’t music): transcribe with
  ~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/transcribe.py "<file>" --edit-dir "./edit/brief"
  adding --language they when the chat or the names are Hebrew. Never write to edit/transcripts/: the edit run owns it.
- Images: look at each one. It is a logo, a reference, a screenshot of a message (read it as instructions) or footage (a photo meant for the video).
- Video: don’t transcribe it; the edit run does. Tell footage from a reference clip by its name, its duration and the chat. Look at one frame only when that doesn’t settle it.
{{> brief-songs}}
{{> brief-music}}

3. Give each file a role: footage, instructions, music, logo, reference or ignore. A voice note with directions is instructions even though it’s audio; a testimonial recorded as audio is footage.

4. Write edit/brief.json in the schema below.
- Fill a field only from what the instructions say. Otherwise leave it null: null means the editor uses video-use’s defaults, which are good.
- Infer only what is close to certain (a reel is 1080x1920; colours sampled from the logo). Write each inference in assumptions, and its field path in assumed (for example look.colors).
- A value that the owner’s note or the client states is not assumed, even when you could also have inferred it: if the note says 1080x1920, canvas is not in assumed. assumed lists only values nobody said, and only fields of the schema. File roles are always your own call, so files is never in assumed.
- Quotes, names and on-screen text go in word for word, in the client’s language and spelling. Don’t write copy the client didn’t give.
- Conflicts: The owner’s note wins. After it, the newest message wins (chat order, then file dates), and the owner’s own messages in a chat beat the client’s. Write each conflict you resolved in assumptions.
- Everything else in English. summary is 3–5 plain sentences an editor can act on.
- To change edit/brief.json after you wrote it, write the whole file again with Write: Edit is not available.
- No instructions and no note: summary "No instructions in the folder.", every other field null, files and assumptions filled.
{{> brief-generate}}

This run is unattended: never ask questions. If a voice note can’t be transcribed, write the brief from everything else, note "not transcribed" on that file and say so in assumptions. You are done when edit/brief.json parses and matches the schema.

Schema:
{{> brief-schema}}
