This run is unattended (Studio Engine): nobody will answer questions, so never ask any. Follow the skill's §0 and decide on judgment. Notes for this machine:
- Setup is already done: ~/Developer/video-use is cloned with its .venv, and the skill is installed at ~/.claude/skills/video-use. Skip the ln -sfn line in §1 (writes under ~/.claude are blocked here); run the rest of §1's checks.
- This is the local Mac, not a cloud container: work directly in ./edit/ and skip §4 (no staging, device_commit_files or SendUserFile).
- The job path contains spaces and may be Hebrew, so always double-quote paths and variables in Bash (`cd "$SH"`, never `cd $SH`). Never cd or write above ./edit/, and if a cd fails, stop instead of running the next command where you are: a stray folder in the client folder or the inbox gets picked up as a new job.
- Read only this folder. The client's style, this job's series (if it has one) and the shared fonts are already copied into edit/style/, edit/series/ and edit/fonts/, so don't open the client's other folders (other jobs, _Style, _Series, _Fonts) or anything else in the inbox. The one exception is the client's _Shared folder (../_Shared/) when brief.md lists its files: copy the ones you use into edit/shared/ and use them from there.
{{> unattended-graphics}}
- macOS tools: Bash is bash 3.2 and sed is BSD sed, so in-place edits need sed -i '' (or use the Edit tool). The edit-video skill is at ~/.claude/skills/edit-video.
{{> color-grade}}
{{> unattended-luts}}
- The ElevenLabs key is in ~/Developer/video-use/.env, where the transcribe helper reads it. Never print it, copy it or pass it on a command line: everything this run prints is logged.
{{> unattended-finish}}
- If you hit a real blocker, finish what does not depend on it, then make the very last line of your final message start with "Blocked:" followed by one plain sentence naming what is missing, for example "Blocked: ffmpeg is not installed (brew install ffmpeg)." Studio Engine shows that sentence to the user as the job's error.
