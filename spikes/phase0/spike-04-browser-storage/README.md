# Spike 0.4 Browser Storage / OPFS Experiment

This dependency-free page writes **generated synthetic bytes** into the Origin Private File System (OPFS) one bounded block at a time. It then reads selected ranges and the whole file back and verifies them against a deterministic generator. It also measures resume-from-offset, reload persistence, storage estimates, the persistence API, explicit deletion, and headroom refusal.

It does not read user files, store media, parse MP4, use MSE, transfer data between peers, or implement Progressive Watch. It makes no network request other than loading its own static files. There is no analytics or telemetry.

## Layout

| File | Responsibility |
| --- | --- |
| `src/plan.mjs` | Spike bounds, headroom admission policy, block/range planning, entry-name and metadata validation, formatting. Re-exports the offset-addressable pattern generator from Spike 0.3. |
| `src/storage.mjs` | OPFS operations over handle interfaces: incremental pattern writes and resume, range and streamed full-file verification, bounded metadata text, deletion with absence confirmation, listing, **Clear Spike Storage**. |
| `src/sync-worker.mjs` | Optional dedicated-worker path using `FileSystemSyncAccessHandle` for in-place writes, resume, flush, in-handle read-back, and lock probing. |
| `src/app.mjs` | Capability table, diagnostics, test orchestration, lab matrix, entries table, event log. |
| `src/storage.test.mjs` | Node unit tests with in-memory fakes of the OPFS handle interfaces. |

`src/plan.mjs` imports the unit-tested pattern generator from `../../spike-03-datachannel-binary/src/framing.mjs`, so the server must serve `spikes/phase0/`, not only this directory.

## Run

From the repository root:

```sh
python3 -m http.server 4175 --bind 127.0.0.1 --directory spikes/phase0
```

Open `http://127.0.0.1:4175/spike-04-browser-storage/`. `127.0.0.1` is a secure context, which OPFS requires. A distinct port gives the spike its own origin and therefore its own OPFS.

- **Run lab matrix** runs ST-01 to ST-06, ST-08 to ST-11, and the supplementary tests, then clears its storage. Tick the optional 1 GiB box only when the estimate shows ample headroom.
- **Request persistence (ST-09)** calls `navigator.storage.persist()` once and records the result.
- **ST-07:** use **Write reload-persistence entry**, reload the page, then click **Verify stored entries after reload**.
- **Clear Spike Storage** removes this experiment's OPFS directory and confirms that it is absent. Run it after ST-07.

Raw per-test evidence is under **Raw JSON evidence**.

## Automated Checks

```sh
node --test src/storage.test.mjs
node --check src/app.mjs src/plan.mjs src/storage.mjs src/sync-worker.mjs
```

The fakes model Chromium's commit-on-close `createWritable()` behavior. They cover:

- Size and headroom refusal paths.
- Range planning.
- Name and metadata validation.
- Reuse of one block buffer.
- Byte-exact verification.
- Resume boundaries and wrong-offset refusal.
- Mid-write `QuotaExceededError` and abort without committed partial data.
- Exact-offset corruption detection.
- Deletion scope and bounded listing.

## Experimental Parameters (not production values)

| Parameter | Value |
| --- | --- |
| Test size bound | 1 MiB – 1 GiB per entry; anything else is refused before any file is created |
| Generation / write block | 64 KiB, 1 MiB (default), or 4 MiB; one reused buffer per write operation |
| Range-verification read | 256 KiB per range, 6–7 ranges (beginning, quarter, middle, unaligned interior, three-quarter, near end, end) |
| Full verification read | 1 MiB blocks via `File.slice().arrayBuffer()` |
| Admission policy | Headroom (`quota − usage`) ≥ 2 × request + 1 GiB reserve, otherwise `INSUFFICIENT STORAGE HEADROOM` |
| Metadata sidecar | ≤ 4,096 characters, schema-checked JSON |

The 2× factor exists because Chromium stages `createWritable()` output in a swap file. A `keepExistingData` resume first copies the existing file into that swap file, and the spike measured usage rising by the full existing file size while one was open.

## Integrity

Bytes come from the seeded 32-bit mixer shared with Spike 0.3, addressed by absolute offset. Either the writer or a later reader can regenerate any range without building the whole file.

Verification compares every byte of each selected range, and the full-file pass compares every byte of the file. No whole-file SHA-256 is computed: `crypto.subtle.digest` is not incremental and would need a full in-memory copy. For deterministic data, byte-exact comparison is a stronger check than a digest. A negative control flips one stored byte and must be detected at that exact offset.

## Storage Naming and Privacy

- All entries live in one OPFS subdirectory, `driftless-spike-04`. OPFS is origin-private and is not the user-visible filesystem; this page has no API path that writes outside it.
- Entry names are generated internally as `<kind>-<MiB>m-<8 hex>.bin` and validated against that pattern. The page deletes only names that pass validation.
- Names found in storage are treated as untrusted text: they are bounded, control characters are replaced, and they are rendered only through `textContent`.
- Metadata read back from storage is schema-checked before use.
- Cached data in OPFS remains sensitive local data. It is reachable by any script on the same origin and persists until deleted or evicted.

## Test Cases

| ID | Procedure | Expected |
| --- | --- | --- |
| ST-01 | Detect APIs and open the OPFS root plus spike directory. | APIs present and directory opens. |
| ST-02 | 1 MiB incremental write. | Write and verification pass. |
| ST-03 | 64 MiB at 64 KiB, 1 MiB, and 4 MiB blocks. | Write and verification pass. |
| ST-04 | 256 MiB, 512 MiB, and optionally 1 GiB. | Pass without whole-file buffering. |
| ST-05 | Selected ranges in every written file. | Deterministic integrity passes. |
| ST-06 | Write, close, reopen, and resume at the stored size, aligned and unaligned. A wrong offset is refused. | Boundary integrity passes. |
| ST-07 | Write an entry with metadata, reload, and verify. | Entry survives the reload. |
| ST-08 | `estimate()` at start and end, and usage around each write. | Usable diagnostics. |
| ST-09 | `persisted()` baseline and one `persist()` request. | Result recorded; denial is not failure. |
| ST-10 | Delete data and metadata, then confirm absence. | Absent; non-spike names refused. |
| ST-11 | Simulated low and unavailable estimates, plus a 2 GiB request. | Refused before any file is created. |
| ST-12 | Physical Android. | `DEFERRED PHYSICAL`. |
| ST-S1 | `createWritable()` visibility while open and after `abort()`. | Recorded. |
| ST-S2 | `FileSystemSyncAccessHandle` in a worker: write, hold, main-thread read, lock probes, in-place resume. | Recorded; integrity passes. |
| ST-S3 | Flip one stored byte. | Detected at the exact offset. |

## Evidence Classification

Headless desktop Chrome automation is `AUTOMATED DESKTOP`. Reported quota depends on the browser, profile, and device and is not a guarantee. Write durations are laboratory observations, not planning values. Physical Android evidence remains deferred.
