# protect-bypass

**Created by Jason Mello & His Buddy Claude** 

**USE AT YOUR OWN RISK**

**A UniFi Protect diagnostic and footage recovery tool that actually works.**

Because sometimes you need your own footage and Protect's case manager just... doesn't.

---

## What it does

**Diagnostics** — SSHes into your NVR and runs 37 checks across system health, storage, services, cameras, network, and logs. Color-coded findings, quick actions, live RAM monitor, and downloadable reports.

**Footage Recovery** — Browse footage by camera name and date, recover clips from raw UBV files, bypassing Protect's download stack entirely. Outputs standard MP4s.

The NVR is **never written to** (except for a small `.ubv.txt` sidecar). Footage is never deleted or modified.

---

## Why this exists

UniFi Protect's case manager downloads hang, fail silently, or produce corrupt files — especially when `unifi-core` is unstable. This tool goes around all of that by pulling raw footage over SFTP and processing it locally.

---

## Requirements

- **Node.js 18+** — https://nodejs.org
- **ffmpeg** — for footage recovery (MP4 output)
- **SSH access** to your UniFi NVR (root)
- **Rust/cargo** — only needed once to build remux; handled automatically by setup

---

## Install & run (all platforms)

```bash
git clone https://github.com/yourusername/protect-bypass.git
cd protect-bypass
npm install
npm run setup
```

`npm run setup` auto-detects your OS, checks dependencies, builds the remux binary, and offers to start the server immediately.

After that, to start the tool any time:

```bash
npm start
```

Then open **http://localhost:3500** in your browser.

---

## What setup does

- Checks Node.js version
- Checks for ffmpeg (warns if missing, diagnostics still work)
- Finds or builds the `remux` binary (installed to `~/.local/bin/remux`)
- Writes `.pb-config.json` so the server always finds remux
- Offers to launch the server immediately

---

## Usage

### Saved NVR profiles
Click **+ Add** in the sidebar to save connection details. Profiles persist between sessions — click any saved profile to load it instantly.

### Diagnostics
1. Load a saved profile or enter IP, port, username, password
2. Click **Run Full Diagnostics** — 37 checks run live
3. Review color-coded findings
4. Use Quick Actions for one-off commands (check RAM, storage, restart services)
5. Save a `.txt` report

### Footage Recovery
1. Switch to **Footage Recovery**
2. Select a **camera** by name (synced from Protect)
3. Select a **date**
4. Select a **clip** — filter by channel (Main / Sub1 / Sub2)
5. Click **Start Recovery Pipeline** → download MP4

---

## Recovery pipeline

| Step | Location | Action |
|---|---|---|
| 1 | NVR → local | SFTP download of `.ubv` file |
| 2 | NVR → local | Download or generate `.ubv.txt` timestamp mapping |
| 3 | Local | Locate `remux` binary |
| 4 | Local | Extract raw H.264/HEVC stream |
| 5 | Local | Re-encode with corrected timestamps (ffmpeg) |

---

## SSH notes

Some UniFi firmware versions reject standard password auth and require `keyboard-interactive`. This tool handles both automatically via `tryKeyboard: true`.

---

## License

MIT
