# Stream fixtures (E1 · CVP-57)

Real `claude -p --output-format stream-json --verbose` output from headless video-use runs, for the
runner (E3) and the progress tracker (E4). Captured on 2026-10-20 with Claude Code 2.1.299 (the
binary bundled with the desktop app), macOS 26.6, arm64. The command is the one in
docs/reference.md, "Running edits". Media files are not committed.

| File | What it is |
| --- | --- |
| `blocked-run.jsonl` | Opus, the full engine command, on a job with one 5 s voice note while ffmpeg and the ElevenLabs key were missing. The skill loads, checks its setup, writes `edit/project.md` and ends on the blocker. 41 s, exit 0. |
| `blocked-run-tree.txt` | The job folder after that run: created and modified times (UTC), bytes, path. |
| `subagent-probe.jsonl` | Haiku probe with the same flags and a scripted prompt: Bash outside the job folder, Write, loading `video-use` with the Skill tool, and one sub-agent (Task). Shows how a background sub-agent appears in the stream. |
| `sample-run.jsonl` | **The full edit.** Opus, the engine command (with `CLAUDE_CODE_SHELL=/bin/bash` and the PATH from docs/reference.md), on `Acme Studio/Launch teaser`: one 1080p30 test-pattern clip with ~15 s of macOS `say` speech and a false start. 249 events, 41 turns, 470 s, exit 0, no permission denials. Result: `edit/final.mp4`, 11.3 s, 1920×1080 H.264/AAC, −14.1 LUFS. The false start is cut, there are 3 HyperFrames graphics and word-highlight captions, and a critic sub-agent pass ran. The 20 base64 image blobs (frames the model looked at) are replaced by `<base64 elided by E1: N chars>`; everything else is byte-for-byte. The real log has lines up to ~1 MB. |
| `sample-run-tree.txt` | (1) When each file appeared in `edit/`, polled every 500 ms during that run (`+` appeared, `~` size settled, `-` removed), with HyperFrames' per-render temp folders collapsed to one line each. (2) The job folder's final tree. The finished job itself is kept in `~/.studio-engine/e1-sample-run/` (not committed). |

## What the stream shows

- **First line is `system/init`.** `skills` must contain `video-use` (proof the CLI loaded it);
  `tools` is `["Task","Bash","Edit","Read","Skill","Write"]`, `permissionMode` is `dontAsk`,
  `mcp_servers` is empty, `model` is the full model id. `session_id` is on every event.
- **Tool calls** are `assistant` events with `message.content[].type == "tool_use"` (`name`,
  `input`); results come back as `user` events with `tool_result` (`is_error`, `content`). The
  skill loads as `tool_use` `Skill` `{"skill":"video-use"}` and the result is
  `Launching skill: video-use`.
- **Sub-agents.** The Task tool shows up as `tool_use` name `Agent` and runs in the background.
  Its own events carry `parent_tool_use_id` = the Agent call's id. Lifecycle comes as
  `system/background_tasks_changed`, `task_started`, `task_progress`, `task_updated`
  (`patch.status: "completed"`) and `task_notification`.
- **More than one `result` per run.** When a background sub-agent is still running at the end
  of a turn, the CLI writes a `result`, then a new `system/init`, runs one more turn when the
  sub-agent finishes, and writes a second `result` (see `subagent-probe.jsonl`). The run is over
  when the process exits, not at the first `result`.
- **Success ≠ `result.subtype`.** The blocked run ends with `subtype: "success"`,
  `is_error: false`, `terminal_reason: "completed"`, and no `final.mp4`. Its `result` text names
  what is missing. A job is done only when the process exits 0 and `edit/final.mp4` exists;
  otherwise the last `result` text is the error to show.
- **Permission denials** (none in these runs) appear as `system/permission_denied` with
  `tool_name`, `tool_use_id` and `message`, and are listed again in `result.permission_denials`.
  The run continues; the model sees the denial as an error tool result.
- **Other events:** `system/thinking_tokens`, `system/task_summary` (a one-line summary of what
  the model is doing, handy as sub-progress text), `system/post_turn_summary`, and a top-level
  `rate_limit_event`.
- **`edit/project.md` can come first.** In the blocked run it is the only file written, before
  any transcript, so `project.md` on its own is not proof the Plan step was reached.

## Order of files in a full edit (`sample-run-tree.txt`)

Seconds from the start of the run. These runs predate the Brief step, so the Step column names the
engine's steps 2 to 8 (Transcribe, Scan, Plan, Cut, Preview, Check, Render); step 1, Brief, comes
before them and is not part of this file tree:

| t (s) | What appeared in `edit/` | Step |
| --- | --- | --- |
| 29 | `transcripts/clip-01.json` and `takes_packed.md` in the same 500 ms tick | Transcribe → Scan |
| 72 | `project.md` (plan, then rewritten at the very end with the hand-off) | Plan |
| 80–120 | `animations/_shared/`, `animations/slot_1/index.html`, then `render.mov` | Cut (graphics) |
| 127 | `edl.json`, `clips_preview/`, `base_preview.mp4`, `master.srt` (removed again at 181) | Cut |
| 149–174 | `animations/words_out.*`, `animations/slot_captions/…/render.mov` (HyperFrames captions via edit-video's builder) | Cut (captions) |
| 187 | `preview.mp4`, then `verify/p_*.jpg`, `verify/grid.jpg` | Preview → Check |
| 233 | `clips_graded/`, `base.mp4`, **`final.mp4`**, `final.srt`, `verify/f_*.jpg` | Render |
| 369–402 | Both slots re-rendered after the critic pass; **`final.mp4` deleted** at 396 and rebuilt from 402 (it starts at 48 bytes and grows), alongside `cut_nohold.mp4` and `verify/g_*.jpg` | Check → Render again |
| 472 | process exits | done |

Lessons for E4:
- `final.mp4` exists long before the run ends, and can disappear and come back. It counts only
  after the process exits (E3).
- `*.prenorm.mp4` files and HyperFrames' `animations/slot_*/work-*/` and `.render.hf-transaction-*/`
  folders (~600 frame files per render) are temporary. Ignore them.
- `verify/` has no numbered self-eval passes. Its file names (`p_*`, `f_*`, `g_*`, `grid*.jpg`)
  are the model's own choice, so "Check n/3" can't come from file names. The stream is a better
  source: Task sub-agents (`system/task_started`, e.g. "Critic pass on teaser") and `task_summary`.
- `system/task_started` / `task_notification` fire for long Bash commands too, not only for
  sub-agents. `task_type` tells them apart: `local_bash` for the 8 render commands in this run,
  `local_agent` (with `subagent_type`) for the critic. All 9 finished inside the turn, so there
  is a single `result`.
