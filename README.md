# Infocat Terminal

A MobaXterm-style desktop terminal client, Infocat-branded. Built with Electron.

- **Tabbed SSH sessions** — connect to multiple servers, each in its own tab
- **Local shell tab** — a built-in terminal for your own machine
- **SFTP file browser** — browse, upload, download, and delete files on the remote host, right next to the terminal
- **Saved sessions** — store host/port/user/auth profiles and reconnect in one click; passwords are encrypted at rest with your OS keychain (DPAPI on Windows, Keychain on macOS, libsecret on Linux)
- **Key, password, or agent auth** — including SSH-agent / Pageant

The whole app rebrands from a single folder — see [Rebranding](#rebranding).

---

## Prerequisites

You need **Node.js 18+** and the native build toolchain (for `node-pty`):

| OS | What to install |
|----|-----------------|
| **Windows** | [Node.js](https://nodejs.org) (the installer's "Tools for Native Modules" checkbox), or run `npm i -g windows-build-tools` |
| **macOS** | Xcode Command Line Tools: `xcode-select --install` |
| **Linux** | `sudo apt install build-essential python3` (or your distro's equivalent) |

## Run it (development)

```bash
npm install      # installs deps and rebuilds node-pty against Electron
npm start        # launches the app
```

If `node-pty` fails to load (local shell disabled), rebuild it against Electron:

```bash
npm run rebuild
```

## Get the Windows installer

The installer is an **NSIS `.exe`** (`Infocat-Terminal-Setup-<version>.exe`): pick an install
folder, get Desktop + Start-menu shortcuts, and uninstall from Add/Remove Programs. It's a
per-user install, so it needs no admin rights. The app icon is the Infocat cat.

Because `node-pty` (the local-shell engine) is a native module, a real Windows `.exe` must be
built **on Windows**. Two ways to get one:

### Option A — Build in the cloud with GitHub Actions (no local toolchain)

A workflow is included at `.github/workflows/build-windows.yml` that builds the installer on a
Windows runner.

1. Push this project to a GitHub repo.
2. Either:
   - go to the repo's **Actions** tab → **Build Windows installer** → **Run workflow**, then
     download the `Infocat-Terminal-Windows-Setup` artifact when it finishes; **or**
   - push a version tag to also publish a GitHub Release with the `.exe` attached:
     ```bash
     git tag v0.1.0
     git push origin v0.1.0
     ```

### Option B — Build locally on a Windows machine

Install [Node.js](https://nodejs.org) (tick **Tools for Native Modules** in the installer), then:

```bash
npm install
npm run dist:win
```

The installer lands in `dist\Infocat-Terminal-Setup-0.1.0.exe`.

> **Signing:** the build is unsigned, so Windows SmartScreen will show a "publisher unknown"
> warning on first run (click *More info → Run anyway*). To remove it, buy a code-signing
> certificate and set the `CSC_LINK` / `CSC_KEY_PASSWORD` env vars — electron-builder signs
> automatically when they're present.

### Other platforms

```bash
npm run dist:mac    # macOS .dmg   (build on macOS)
npm run dist:linux  # Linux AppImage (build on Linux)
```

---

## Using the app

- **+ New SSH** (sidebar) or **Connect over SSH** opens the connection dialog. Fill in host, user, and auth. Tick **Save this session** to keep it in the sidebar.
- **Local shell** opens a tab running your default shell.
- Click a **saved session** to reconnect. Hover it for edit / delete.
- When an SSH tab is active, the **Files** panel on the right shows that server's filesystem over SFTP. Double-click folders to navigate; use the toolbar to go up, refresh, make a folder, upload, or download.

Shortcuts: `Ctrl/Cmd+Shift+T` new local tab · `Ctrl/Cmd+W` close tab · `Esc` close dialog.

---

## Rebranding

Everything visual lives in **`src/branding/`**:

- **`branding.json`** — app name, tagline, window title, UI color palette, and the terminal color theme. Edit the values; the app reads them at launch and injects them as CSS variables, so no other file needs to change.
- **`logo.png`** — the app / installer icon (512×512, used by electron-builder).
- **`logomark.png`** — the mark shown in the sidebar and welcome screen.

Swap those two images and adjust the colors, and the entire app is rebranded.

---

## Project layout

```
infocat-term/
├─ package.json
├─ src/
│  ├─ main.js          Electron main process: windows, SSH, PTY, SFTP, IPC
│  ├─ preload.js       Safe contextBridge API exposed to the UI
│  ├─ sessionStore.js  Saved sessions + OS-keychain credential encryption
│  ├─ branding/        ← all branding (colors, names, logos) lives here
│  └─ renderer/
│     ├─ index.html
│     ├─ styles.css
│     └─ renderer.js   Tabs, terminals (xterm.js), SFTP panel, dialogs
```

## Security notes

- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`; it never touches Node or `ssh2` directly — only the small API in `preload.js`.
- Saved passwords/passphrases are encrypted via Electron `safeStorage` (OS keychain). If the OS backend is unavailable, secrets are stored obfuscated (not securely) and the sidebar shows a warning — prefer key or agent auth in that case.
- Host key verification is not yet enforced (it accepts the server's key on first connect). Adding a known-hosts trust prompt is a good next step for production use.

## Roadmap ideas

RDP/VNC tabs, split panes, a tunnels/port-forwarding manager, drag-and-drop upload into the SFTP panel, session folders/groups, and known-hosts verification.
