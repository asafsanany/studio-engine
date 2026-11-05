# Studio Engine

**Drop raw footage in a folder. Get an edited video back.**

Studio Engine runs on your own computer and edits every job with [Claude Code](https://claude.com/claude-code). It cuts, captions and grades the video, then waits for your notes before it renders.

![The Jobs list, with jobs editing, queued and ready to review](docs/images/jobs.png)

## How it works

1. **Drop** your footage into `~/Studio Inbox/<Client>/<Job>`.
2. **It edits by itself:** cuts, captions, graphics, colour and music, with every step on screen.
3. **Review** it in a live player. Type or record a note at any moment, and it makes a new version.
4. **Approve,** and the final video lands in `_Exports/<Client>/<Job>.mp4`.

<p align="center">
  <img src="docs/images/review.png" width="620" alt="The Review player, with two notes pinned to moments in the video">
</p>

![A job opened under its row, showing its steps, notes and details](docs/images/job.png)

## What else it does

- **Client styles and series.** Each client keeps its own look, and the episodes of a series share one design.
- **Your graphics, fonts and LUTs.** Import them or ask for them in a chat, then name them in a note with `@`.
- **Videos with no footage.** Write a brief and it generates the shots and the voice.
- **Right-to-left captions.** Hebrew captions come out the right way round.
- **Money and Analytics.** See what each job earned and cost, and how fast you deliver.
- **Instagram.** Compare the reels you edited with the client's other reels.
- **Your phone.** Review and approve on your iPhone through Tailscale.

<table>
  <tr>
    <td width="50%"><img src="docs/images/analytics.png" alt="Analytics: jobs finished, editing time and footage per week"></td>
    <td width="50%"><img src="docs/images/instagram.png" alt="A client's Instagram: followers and the plays of every reel"></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/money.png" alt="The month's income, expenses and profit"></td>
  </tr>
  <tr>
    <td><img src="docs/images/luts.png" alt="A LUT as a before and after on a test photo"></td>
    <td><img src="docs/images/phone.png" alt="The Jobs list on a phone, grouped by client"></td>
  </tr>
</table>

<sub>Every image is a real component from the app, rendered on its own with sample data.</sub>

## Try it

The `demo` branch runs the whole app on made-up data, with no keys, no footage and no Claude login. You need Node 22 and pnpm.

```bash
git clone -b demo https://github.com/asafsanany/studio-engine.git
cd studio-engine
pnpm i
pnpm demo
```

Then open <http://127.0.0.1:4320>. Nothing edits for real, and pressing Ctrl+C removes the data.

## Run it for real

You need Node 22, pnpm, ffmpeg and Claude Code logged in.

```bash
git clone https://github.com/asafsanany/studio-engine.git
cd studio-engine
pnpm i
mkdir -p ~/.studio-engine
cp config.example.json ~/.studio-engine/config.json
cp money.example.json ~/.studio-engine/money.json
cp .env.example .env
pnpm run doctor
pnpm dev
```

`pnpm run doctor` checks everything an edit needs and prints the fix for anything missing, including the two editing skills. `.env.example` says what each key is for. Then open <http://localhost:5173>.

## Learn more

- [Reference](docs/reference.md): settings, running in the background, the phone setup and how edits run.
- [`skills/video-use`](skills/video-use/README.md) and [`skills/edit-video`](skills/edit-video/README.md): the editing skills.

## License

[MIT](LICENSE). A few bundled files keep their own terms, including GSAP, which isn't open source. They're listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
