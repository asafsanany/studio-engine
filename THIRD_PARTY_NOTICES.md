# Third-party files

The [MIT license](LICENSE) covers this project's own code. The files below come from other people and keep their own terms.

| What | Where | Owner | License |
| --- | --- | --- | --- |
| GSAP 3.15.0 | `apps/server/assets/graphics/vendor/gsap.min.js`, `apps/server/src/pipeline/testdata/preview/vendor/gsap.min.js` | GreenSock | [GSAP Standard License](https://gsap.com/standard-license). Not open source, so MIT doesn't apply to it. Read its terms before building on this project, including what it says about tools that compete with Webflow |
| Heebo | `apps/server/src/graphics/testdata/fonts/` | The Heebo Project Authors | [SIL Open Font License 1.1](licenses/OFL-1.1.txt) |
| Noto Sans Hebrew | `apps/server/src/pipeline/testdata/preview/assets/fonts/` | The Noto Project Authors | [SIL Open Font License 1.1](licenses/OFL-1.1.txt) |
| Bellefair, Oswald, Outfit, Secular One, Varela Round | `fixtures/fonts/` | Each font's Project Authors, named inside each file | [SIL Open Font License 1.1](licenses/OFL-1.1.txt) |
| Three test photos | `apps/server/assets/luts/frames/` | Benjamin Combs, Nicholas Swanson and The Anchor, on Unsplash | [Unsplash License](https://unsplash.com/license). Sources are in [`CREDITS.md`](apps/server/assets/luts/frames/CREDITS.md) |
| The original video-use skill | `skills/video-use/` builds on it | Browser Use | MIT, kept in [`skills/video-use/LICENSE`](skills/video-use/LICENSE) |
| UI components | `apps/web/src/components/ui/` start from shadcn/ui | shadcn | MIT, [Copyright (c) 2023 shadcn](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md) |

Packages installed by `pnpm install`, and tools fetched at run time such as HyperFrames (Apache-2.0, by HeyGen), aren't part of this repo and come with their own licenses.
