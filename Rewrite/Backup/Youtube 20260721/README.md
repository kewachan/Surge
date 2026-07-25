# Youtube Enhance

This document describes the complete project, its local and published locations, the expected behavior, and the maintenance workflow. It is intended to let a new session continue the work without reconstructing the previous history.

> **Local-only file:** `README.md` is a private maintainer handoff document. Never copy, stage, commit, or push it to the GitHub repository.

## Purpose

Youtube Enhance is a Surge module for YouTube and YouTube Music. It modifies protobuf API responses and encrypted `initplayback` UMP responses to filter advertising and shopping components while preserving normal watch-page content such as comments and filter chips.

It also enables selected playback and interface enhancements and can optionally translate captions.

## Current Features

- Filters player advertisements.
- Filters Sponsored cards in home feeds, continuation feeds, watch-next results, and the area below comments.
- Removes the timely shopping or product shelf displayed below a video.
- Preserves comments, chapters, metadata updates, and the watch-page filter-chip row such as All, Related, and For you.
- Enables background playback and Picture in Picture capabilities in player responses.
- Exposes download-related settings when the YouTube response supports them.
- Optionally hides the Upload, Immersive, and Shorts buttons.
- Optionally adds a translated caption track using Google's public web translation endpoint.
- Supports separate YouTube and YouTube Music encryption-key state.

Caption translation is disabled by default. The added track is named `Enhance (language-code)`, without an `@` prefix.

Regional fallback is not part of the current module. The earlier fallback experiment was removed intentionally.

YouTube frequently changes its API response layouts, so future app updates may require corresponding script updates. No filtering method should be treated as permanent or guaranteed.

## Request Flow

```text
YouTube API response
        |
        v
youtube.response.js ---- filters API protobuf responses and saves Onesie keys

googlevideo.com/initplayback
        |
        v
youtube.request.js ---- redirects eligible encrypted requests to the Worker
        |
        v
youtube.worker.js ---- resolves the upstream response, decrypts, filters,
                       signs, and re-encrypts UMP

youtube.com/api/timedtext
        |
        v
youtube.caption.js ---- batches, translates, caches, and rebuilds srv3 captions
```

Encrypted `initplayback` filtering uses the deployed Cloudflare Worker. The local playback-response experiment was removed because it did not block continuation-delivered advertisements reliably.

## Requirements

- Surge with scripting and HTTPS decryption support.
- The Surge CA certificate installed and trusted on the device.
- A deployed Cloudflare Worker for encrypted `initplayback` filtering.
- HTTPS decryption enabled for the hostnames listed in the module.

## Installation

Add this module URL to Surge:

```text
https://raw.githubusercontent.com/kewachan/Surge/main/Rewrite/Youtube/YouTube.Enhance.sgmodule
```

Enable the module, install and trust the Surge CA certificate, then update the module and all external resources in Surge.

## Module Arguments

| Argument | Default | Description |
| --- | --- | --- |
| Block Upload Button | `true` | Hides the Upload button. |
| Block Immersive Button | `true` | Hides the Immersive button. |
| Block Shorts Button | `false` | Hides the Shorts button when enabled. |
| Caption Translation Language | `off` | Uses a Google Translate language code, such as `zh-Hant`, or `off` to disable translation. |
| Enable Debug Mode | `false` | Writes additional diagnostic information to the Surge script log. |

## Project Files

| File | Purpose |
| --- | --- |
| `YouTube.Enhance.sgmodule` | Surge module metadata, arguments, script rules, patterns, and MITM hostnames. |
| `youtube.response.js` | Filters YouTube API responses, modifies UI and playback capabilities, adds caption tracks, and stores Onesie encryption keys. |
| `youtube.request.js` | Handles `log_event`, reads saved keys, and redirects eligible `initplayback` requests to the Worker. |
| `youtube.caption.js` | Translates `srv3` captions with batching, retries, time limits, and a seven-day Surge persistent cache. |
| `youtube.worker.js` | Active Worker implementation that proxies, decrypts, filters, signs, and re-encrypts UMP. |
| `README.md` | Local-only project documentation and maintainer handoff instructions. Never publish this file. |

Important implementation details:

- `youtube.response.js` is largely bundled and minified. Preserve its custom wrappers and patches at the beginning of the file when updating the upstream-derived bundle.
- Advertisement classification state is isolated by API path to reduce false positives between browse, next, search, and other responses.
- `youtube.worker.js` removes only known ad or shopping structures and deliberately preserves the filter-chip renderer and normal comment content.
- The Worker validates the Googlevideo target and returns unsupported payloads unchanged whenever possible.
- `youtube.caption.js` uses a public Google Translate web endpoint without an API key. Public rate limits and availability still apply.

## Local Locations

Primary editing and test workspace: the current workspace root containing the `Script` and `tools` folders.

```text
<workspace-root>
```

Editable YouTube sources:

```text
<workspace-root>/Script/Youtube
```

GitHub publishing repository:

```text
/Users/kewachan/Documents/GitHub/Surge
```

Published folder inside the repository:

```text
/Users/kewachan/Documents/GitHub/Surge/Rewrite/Youtube
```

The `Script/Youtube` copy is the working source. Before every Git push, copy the module and four JavaScript files into `Rewrite/Youtube`. Keep `README.md` exclusively in the working source folder.

## Published URLs

- Module: <https://raw.githubusercontent.com/kewachan/Surge/main/Rewrite/Youtube/YouTube.Enhance.sgmodule>
- Response script: <https://raw.githubusercontent.com/kewachan/Surge/main/Rewrite/Youtube/youtube.response.js>
- Request script: <https://raw.githubusercontent.com/kewachan/Surge/main/Rewrite/Youtube/youtube.request.js>
- Caption script: <https://raw.githubusercontent.com/kewachan/Surge/main/Rewrite/Youtube/youtube.caption.js>
- Worker source: <https://raw.githubusercontent.com/kewachan/Surge/main/Rewrite/Youtube/youtube.worker.js>

The active Worker service is `youtube-init` at `https://youtube-init.hmtw47cv7m.workers.dev/`.

## Testing

Run tests from the primary workspace before copying and pushing changes:

```sh
cd <workspace-root>
node tools/test-youtube-caption.cjs
node tools/test-youtube-caption-retry.cjs
node tools/test-youtube-worker.cjs
node tools/test-youtube-response.cjs /path/to/capture.har
```

Test notes:

- The caption tests are self-contained.
- The playback and Worker tests currently expect the captured binary fixture at `/tmp/yt-worker-response.bin`.
- `test-youtube-response.cjs` requires a HAR path and selects a YouTube `browse` response by default.
- For another endpoint, set `RESPONSE_PATH`, for example `RESPONSE_PATH=next`.
- Keep comments and the filter-chip row present while confirming that ad markers disappear.
- After changing a bundled script, also run `node --check` on any non-module JavaScript that Node can parse directly.

## Git Push Workflow

Maintainer convention: when the user says `Push`, copy the current module and four JavaScript files to the publishing repository, run the relevant checks, write a concise commit message that explains the actual change, and push. Do not ask for the folder or command again unless the filesystem layout has actually changed.

Never use `update` as the complete commit message. Use a short, specific description such as `Fix Worker redirect handling`, `Improve sponsored card filtering`, or `Update caption translation batching`.

`README.md` must remain local. Before committing, confirm that it is absent from the publishing repository and absent from both staged and untracked Git output. Never add it to the copy or `git add` commands.

Use this sequence:

```sh
cd <workspace-root>
cp Script/Youtube/YouTube.Enhance.sgmodule /Users/kewachan/Documents/GitHub/Surge/Rewrite/Youtube/
cp Script/Youtube/youtube.response.js /Users/kewachan/Documents/GitHub/Surge/Rewrite/Youtube/
cp Script/Youtube/youtube.request.js /Users/kewachan/Documents/GitHub/Surge/Rewrite/Youtube/
cp Script/Youtube/youtube.caption.js /Users/kewachan/Documents/GitHub/Surge/Rewrite/Youtube/
cp Script/Youtube/youtube.worker.js /Users/kewachan/Documents/GitHub/Surge/Rewrite/Youtube/

cd /Users/kewachan/Documents/GitHub/Surge
test ! -e Rewrite/Youtube/README.md
git status --short
git diff --check -- Rewrite/Youtube
git add Rewrite/Youtube/YouTube.Enhance.sgmodule Rewrite/Youtube/youtube.response.js Rewrite/Youtube/youtube.request.js Rewrite/Youtube/youtube.caption.js Rewrite/Youtube/youtube.worker.js
git diff --cached --check
git diff --cached --stat
git commit -m "<short description of the actual change>"
git push
```

Stage only the intended module and four JavaScript files. Do not use `git add .` when unrelated files are modified. Never stage `README.md`. In particular, preserve and do not commit unrelated `.DS_Store` changes.

Do not print the authenticated Git remote URL or any credential stored in it. Public GitHub links are sufficient for documentation and verification.

After pushing:

1. Confirm that the local branch is clean except for known unrelated user files.
2. Confirm that the new commit is on the remote branch.
3. Open the raw URLs with a cache-busting query when verifying content, for example `?cachebust=20260718`.
4. Update the module and all external resources in Surge.
5. Force quit and reopen YouTube before testing.

Keep the project and module name exactly `Youtube Enhance`. Do not append version numbers or extra wording to the name.

## Cloudflare Worker Deployment

Cloudflare deployment is separate from GitHub. Redeploy the complete `youtube.worker.js` whenever it changes. The Worker is POST-only; opening it in a browser should return `405 Method Not Allowed`.

## Troubleshooting Checklist

1. Confirm the module is enabled.
2. Confirm the Surge CA certificate is installed and trusted.
3. Confirm MITM covers `*.googlevideo.com`, `youtubei.googleapis.com`, and `www.youtube.com`.
4. Confirm all external resources were refreshed after the latest Git push.
5. Confirm `youtube.request.js` redirects eligible `initplayback` requests to the active Worker.
6. Confirm the Worker response contains `x-youtube-worker-build: init-redirector-v1`.
7. Force quit and reopen YouTube to clear its active response state.
8. Capture a new HAR from the exact failing screen if the problem remains.

Common symptom guidance:

- Advertisement still visible: identify whether it came from `browse`, `next`, or encrypted `initplayback`; the responsible filter differs.
- Worker response has no `removed-N` header: inspect the status, content type, build header, and Worker logs.
- Comments fail to load: check that a broad renderer was not removed. Preserve NextResponse content unless a known ad or shopping marker exists.
- Filter-chip row is missing: verify that the watch-next chip renderer is explicitly preserved in the shared playback core.
- Background audio works but lock-screen metadata is blank: playback capability and iOS Now Playing metadata are separate; the current enhancement enables playback but cannot guarantee metadata supplied by the app.
- Caption remains in the original language: confirm the module language is not `off`, the added track is selected, and the public Google endpoint was not rate-limited.

HAR files may contain cookies, account tokens, authorization headers, device identifiers, and signed media URLs. Remove sensitive data before sharing or committing them. Do not commit HAR captures to the public repository unless they have been carefully sanitized.

## Scope Decisions from Earlier Work

- Module name remains `Youtube Enhance`.
- Module text and documentation are in English.
- Caption track label remains `Enhance`, not `@Enhance`.
- Caption translation uses Google's public web translation service; MyMemory and other attempted services are not used.
- Caption translation default remains `off`.
- Regional fallback was removed and should not be restored unless explicitly requested.
- The failed local playback-response experiment was removed; the active architecture uses the project Worker.
- The module does not include Facebook ad blocking.

## Disclaimer

This is an unofficial project and is not affiliated with YouTube, Google, Cloudflare, or Surge. Use it for personal and educational purposes. Features may stop working when the apps or APIs change.
