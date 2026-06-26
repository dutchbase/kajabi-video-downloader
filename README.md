# Kajabi Video Downloader

Download videos from Kajabi courses you have access to — Wistia-hosted and native HLS streams.

## Features

- **One-click downloads** from Kajabi course pages
- **Bulk course download** — open a course overview page to download all lessons at once
- **Checkbox selection** — pick exactly which lessons to download before starting
- **Quality selection** for Wistia videos (original + multiple resolutions) and bulk downloads
- **HLS playlist support** with automatic decryption (AES-128)
- **No external dependencies** — works offline, no build required
- **Clean room code** — fresh implementation, no proprietary watermarks or telemetry

## Installation

1. Download or clone this repository
2. Open **Brave** → `brave://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `extension/` folder from this repo
6. Done — the extension is now active

## Usage

### Wistia Videos (Most Kajabi courses)
1. Navigate to a Kajabi lesson with a Wistia video
2. A blue **⬇ Download** button appears in the top-right corner
3. *Optional:* click the extension icon (⬇) to open the popup and select video quality
4. Click **Download** — browser prompts you to save the MP4

### Native HLS (Some Kajabi courses use Kajabi's own player)
1. Navigate to a Kajabi lesson with HLS streaming
2. The blue **⬇ Download** button appears automatically
3. Click **Download** — the extension fetches the full HLS stream, assembles it, and saves as MP4

### Bulk Course Download
1. Navigate to a **course overview page** (the page that lists all lessons, not an individual lesson)
2. Click the extension icon — it detects all lesson links and shows a lesson list
3. **Check/uncheck** the lessons you want; click **Deselect all** or **Select all** to toggle
4. *Optional:* choose a quality from the **Quality** dropdown (Best available, 1080p, 720p, 480p, 360p)
5. Click **Download All** (or **Download Selected (N)** if you unchecked some)
6. The extension opens each lesson in a background tab, detects the video, downloads it, then moves to the next — progress is shown in the popup
7. Click **Cancel** at any time to stop mid-queue

> **Tip:** Supported lesson URL patterns: `/posts/` and `/lessons/` (both are used by Kajabi).

## Limitations

- **Wistia only:** AES-128 encryption only (no DRM/SAMPLE-AES)
- **HLS only:** AES-128 encryption only; MPEG-TS legacy segments concat naively (clean fMP4 streams remux properly)
- **Memory:** Entire video buffered in RAM (suitable for course-length clips, not 4K features)
- **Auth:** Requires you to be logged into Kajabi in the same browser; uses your existing session cookies

## Permissions

- `downloads` — save files to your Downloads folder (Wistia only; HLS uses native `<a download>`)
- `storage` — remember which video you're watching (local only, per-session)
- `tabs`, `activeTab`, `scripting` — detect videos on the current page
- `host_permissions` — access Kajabi and Wistia APIs

No telemetry, no external phone-home calls.

## Troubleshooting

**No button appears:**
- Refresh the page
- Ensure you're on a Kajabi domain (kajabi.com or mykajabi.com)
- Check DevTools Console (F12) for errors

**"Download failed" error:**
- Verify you're logged into Kajabi
- For private/members-only videos, wait for the page-context fetch fallback (~2 seconds)
- Try again — some Wistia CDN redirects are flaky

**Video won't play after download:**
- Confirm your player supports MP4 (VLC, QuickTime, etc.)
- Verify download completed fully (file size > 100 MB for typical course videos)

## Development

- `manifest.json` — MV3 configuration
- `content.js` — Page detection + button injection (Wistia + HLS)
- `background.js` — Download routing + Wistia API + HLS assembly
- `popup.html` / `popup.js` — Quality picker UI

No build step, no dependencies. Edit and reload at `brave://extensions`.

## License

MIT — use freely, modify, distribute. No warranty.
