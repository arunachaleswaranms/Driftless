# Spike 0.1 Local Media Playback Experiment

This dependency-free page tests browser-native playback of a user-selected local file. It uses the File API only to receive the browser-provided `File` reference and binds that `Blob` to the native `<video>` element with `URL.createObjectURL()`.

It does not upload media, parse media bytes in JavaScript, call `FileReader`, call `arrayBuffer()`, or create an application-level copy of the selected file. The page contains no analytics, telemetry, remote endpoint, or network request code. Its Content Security Policy disables outbound connections.

## Run

From the repository root:

```sh
python3 -m http.server 4173 --directory spikes/phase0/spike-01-local-media
```

Then open `http://127.0.0.1:4173/` in the browser under test. Keep test media under `spikes/phase0/test-media/` or another local-only location. Do not add test media to Git.

The HTTP server delivers only static experiment files to the local browser. The page performs no upload. Browser developer tools should show no page-initiated requests after the initial HTML, JavaScript, and CSS resources load.

## Automated Checks

No package installation is required:

```sh
node --test src/formatters.test.mjs
node --check src/app.mjs
node --check src/formatters.mjs
```

The automated tests cover deterministic display and diagnostic formatting only. They do not prove native decoding, playback, seeking, cleanup, large-file resource behavior, or mobile compatibility.

## Manual Test Cases

Record every run in `../results/spike-01-local-media.md` with the exact date, browser version, operating system/device, and media characteristics.

### LM-01 Select compatible MP4

1. Open the experiment.
2. Select an MP4 containing H.264/AVC video and AAC audio.
3. Wait for metadata to load.

Expected: filename, size, MIME type, duration, resolution, ready state, network state, buffered ranges, and seekable ranges are visible. No media request goes to a remote server.

### LM-02 Start playback

1. Press Play in the native controls.
2. Observe the picture, sound, current time, and event log.

Expected: playback advances normally and diagnostics update.

### LM-03 Pause and resume

1. Pause after playback begins.
2. Wait several seconds.
3. Resume.

Expected: the position stops while paused, then playback continues without corruption.

### LM-04 Seek forward significantly

1. Begin playback near 5 minutes.
2. Seek to approximately 45 minutes, or use comparably distant positions for a shorter file.
3. Resume playback.

Expected: the seek completes and decoded playback resumes at the target.

### LM-05 Seek backward

1. From a later position, seek substantially backward.
2. Resume playback.

Expected: the seek completes and decoded playback resumes at the target.

### LM-06 Select another file

1. While a file is loaded, choose a different local video.
2. Confirm the page logs cleanup before binding the replacement.
3. Optionally use **Clear selection**, then choose another file.

Expected: playback stops, the previous `src` is removed, `load()` releases the prior media resource, and the prior object URL is revoked before the replacement is bound. The new file metadata replaces the old values.

### LM-07 Large file

1. Open browser task-manager/developer memory tools.
2. Select compatible files around 500 MB, 1 GB, 2 GB, and larger if lawfully available.
3. Load metadata, play, pause, and seek without reading the file through other tooling.
4. Observe renderer memory before selection, after metadata, during playback, after repeated seeks, after replacement, and after **Clear selection**.

Expected: the page makes no application-level full-file copy, remains responsive, and releases the prior object URL/resource on replacement or clear. Record measured memory observations; code inspection alone does not prove browser/decoder resource behavior.

### LM-08 Unsupported or incompatible media

1. Select a non-target file or an MP4 with an unsupported codec/profile.
2. Attempt playback.

Expected: the compatibility note and native media error/event diagnostics are visible; the page remains responsive and permits replacement or clear.

### LM-09 Physical Android Chrome

1. Serve the page from a computer reachable by the Android device on the local network. Bind the static server to the required interface only for the test, and use an appropriate host firewall.
2. On a physical Android device, record device model, Android version, Chrome version, available storage, network type, and test date.
3. Open `http://<computer-lan-ip>:4173/` in Chrome. If local-network HTTP restrictions or policy block the page, use a temporary HTTPS static host that serves only these experiment files and record the setup; do not add uploads or telemetry.
4. Select a compatible local MP4 from device storage.
5. Complete LM-01 through LM-06, then repeat with the largest available compatible file (at least approximately 1 GB when available).
6. Run LM-08 and record any file-picker, permission, lifecycle, memory, playback, or seeking failures.

Expected: file selection, metadata, playback, pause/resume, forward seek, backward seek, replacement cleanup, and clear error handling succeed on the real device. Emulator or desktop mobile simulation evidence must not be recorded as LM-09.

## Cleanup

Use **Clear selection** before closing the page when practical. The experiment also revokes the active object URL on page hide. Delete local media independently when the test session is complete; the page never writes or uploads it.
