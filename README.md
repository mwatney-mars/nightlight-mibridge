# Nightlight MiBridge

Bridge Xiaomi Cloud cameras (via [`go2rtc`](https://github.com/AlexxIT/go2rtc)) to **RTSP** and **ONVIF** so they can be added to [**Nightlight**](https://github.com/sauso/nightlight) (or any RTSP/ONVIF NVR).

> Based on [`mwatney-mars/micamerapro`](https://github.com/mwatney-mars/micamerapro) with an integrated ONVIF bridge, optional HEVC → H.264 transcoding, URL-safe stream slugs, and a minimal dashboard.

## What it does

* **Xiaomi Cloud → RTSP:** Authenticates with Xiaomi Cloud (including Captcha & 2FA), discovers your cameras by region, and publishes them through embedded `go2rtc` (`v1.9.14`).
* **HEVC → H.264 transcoding:** Newer Xiaomi cameras (e.g. **Xiaomi Smart Camera C400**) stream HEVC (`H.265`), which Nightlight's browser WebRTC player cannot play directly because Nightlight copies video (`-c:v copy`). Enabling **H.264 transcode** creates a two-stage pipeline (`<slug>_raw` → `ffmpeg:<slug>_raw#video=h264#audio=copy`) using `ffmpeg` inside the container.
* **Per-stream ONVIF bridge (`onvifBridge.js`):** Exposes each published stream (ignoring `*_raw` helper streams) on its own ONVIF HTTP port (`8901`, `8902`, …) and responds to **WS-Discovery** (`239.255.255.250:3702` UDP) so Nightlight's **Find cameras on my network** can discover each camera automatically.
* **Multi-camera support:** Publishing one camera does not stop other active cameras.

## Quick start (Docker)

1. Create the external data volume (persists `go2rtc.yaml`):
   ```bash
   docker volume create micamerapro_data
   ```

2. Build and start with Docker Compose (`network_mode: host` is used so WS-Discovery multicast and Nightlight on the same host work cleanly):
   ```bash
   docker compose up -d --build
   ```

3. Open the Web UI at `http://<host-ip>:3000` (default `ADMIN_PASSWORD=admin` in `docker-compose.yml` — change it via `.env`).

> **Running on the same host as Nightlight?**
> Nightlight's embedded `mediamtx` binds port `8554` (`127.0.0.2:8554`). Set `RTSP_PORT=8555` in `.env` and pass `RTSP_PORT=${RTSP_PORT:-8555}` in `docker-compose.yml` so `go2rtc` listens on `:8555` instead of colliding on `:8554`.

## Adding a camera to Nightlight

1. In **Nightlight MiBridge** (`http://<host-ip>:3000`):
   * Click **Connect Xiaomi** and complete login (and Captcha/2FA if prompted).
   * Select your account and region, then click **Publish HD** (or **Publish SD**) on your camera. Keep **H.264 transcode (for C400 / HEVC)** checked if your camera outputs HEVC.
   * Note the **RTSP URL** and **ONVIF Port** under **Active Nightlight Bridges**.

2. In **Nightlight** (`http://<host-ip>:4000` → **Cameras → Add camera**):
   * **Option A (Auto-discovery):** Click **Find cameras on my network** to discover the camera via WS-Discovery (uses the `8901+` ONVIF port automatically).
   * **Option B (Manual RTSP):** Open **Add a camera manually** (do **not** click *Fetch from ONVIF*, which probes port `80` by default):
     * **Camera IP address:** `<host-ip>`
     * **RTSP port:** `8554` (or `8555` if configured via `RTSP_PORT`)
     * **Username / Password:** leave blank
     * **Stream path** (under *Advanced*): `/<stream_slug>` (e.g. `/xiaomi_smart_camera_c400`)
     * Click **Add camera**.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Web UI & Express proxy port |
| `DATA_DIR` | `/app/data` (Docker) | Directory storing `go2rtc.yaml` |
| `ADMIN_PASSWORD` | `admin` (Compose) | Protects Web UI, `/api/*`, and WebSocket upgrades; unset to disable |
| `RTSP_PORT` | `8554` | `go2rtc` RTSP listen port (set to `8555` alongside Nightlight) |
| `ONVIF_BASE_PORT` | `8901` | Starting HTTP port for per-stream ONVIF servers |
| `ONVIF_ENABLED` | `true` | Set `false` to disable the ONVIF bridge |
| `ONVIF_DISCOVERY` | `true` | Set `false` to disable WS-Discovery on UDP `3702` |
| `XIAOMI_USER` | — | Optional Xiaomi user ID injected into `go2rtc.yaml` on boot |
| `XIAOMI_TOKEN` | — | Optional Xiaomi token injected into `go2rtc.yaml` on boot |

## Architecture

* **`server.js`** — Express server serving the React UI (`dist/`), admin session auth, `/api/nightlight` status endpoint, and proxy to `go2rtc` (`127.0.0.1:1984`).
* **`onvifBridge.js`** — Polls `go2rtc` `/api/streams`, runs one lightweight SOAP/HTTP ONVIF server per stream (`GetSystemDateAndTime`, `GetCapabilities`, `GetServices`, `GetDeviceInformation`, `GetProfiles`, `GetStreamUri`), and responds to WS-Discovery probes.
* **`go2rtc`** — Handles Xiaomi Cloud authentication, camera P2P/stream pulling, RTSP server, and `ffmpeg` H.264 transcoding.
* **`src/App.jsx`** — React frontend for Xiaomi login, multi-camera publishing, copyable ONVIF/RTSP details, and optional WebRTC preview.
