# Spike 0.4 Result — Browser Storage / OPFS Feasibility

## Spike

`0.4 — Browser Storage / OPFS Feasibility`

## Result

`PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`

Software feasibility passed in controlled desktop testing:

- OPFS stored, randomly read, resumed, reloaded, measured, and deleted synthetic entries of 1 MiB to 1 GiB in headless Chrome 153 on macOS.
- Every verified byte matched the deterministic generator.
- The application wrote through one reused block buffer and never assembled a whole file in JavaScript memory.
- No architectural blocker was found.

Two write-path limitations were measured and must shape later transfer/cache design:

- Chromium's `createWritable()` commits only on `close()`.
- A `keepExistingData` resume copies the whole existing file.

Full `PASS` is withheld because ST-12, physical Android Chrome, has no evidence.

OPFS appears viable for later architecture work. This result does not select OPFS as the final Driftless cache design.

## Experiment Scope

The experiment tests the storage primitive only. It excludes media files and bytes, user-file access, MP4 parsing, MSE, peer transfer, synchronization, and Progressive Watch.

- Payloads are generated deterministically, one block at a time, from Spike 0.3's offset-addressable 32-bit mixer.
- No large fixture exists on disk or in Git. Test data existed only inside a throwaway browser profile's OPFS and was deleted.

## Environment

- Date: 2026-09-26. Repository revision `0664735` plus uncommitted Spike 0.4 files.
- Host: macOS 26.6.2 (25G83). Node.js v26.3.0. Host volume: 926 GiB, 596 GiB free before testing.
- Browser: Google Chrome 153.0.8010.53, `--headless=new`, a throwaway temporary profile deleted after each run, and `--enable-precise-memory-info`. A scratchpad Chrome DevTools Protocol driver, not committed, clicked the page controls, reloaded the page, and sampled heap usage.
- Origin: `http://127.0.0.1:4175` (secure context; a port unused by earlier spikes, so the origin started with empty storage). Page `visibilityState: visible`.
- Headless Chrome was used directly, following the Spike 0.3 precedent that the Chrome-extension session could not reach loopback URLs. No headed, user-profile, Edge, Firefox, or Safari run was performed.
- **Run A** (07:56 UTC) and **Run B** (07:58 UTC) executed the same storage logic. Before run B, instrumentation was refined:
  - separate write-phase heap peak;
  - CDP `Runtime.getHeapUsage` sampling plus a forced GC;
  - ST-S2's main-thread read upgraded from an unverified 4 KiB read to 7 pattern-verified ranges;
  - the optional 1 GiB write enabled.

  Figures below are from run B unless marked A/B.

## AUTOMATED PASS

```text
node --test <all Phase 0 test files>
PASS — 29 tests, 0 failed; 9 belong to Spike 0.4.

node --check on every Spike 0.4 module — PASS.
```

The Spike 0.4 tests run the real `storage.mjs` against in-memory fakes of the OPFS handle interfaces. The fakes use Chromium-like commit-on-close semantics. The tests cover:

- Size and headroom refusals.
- Range planning.
- Name and metadata validation.
- One reused write buffer.
- Byte-exact verification.
- Aligned and unaligned resume boundaries and wrong-offset refusal.
- Mid-write `QuotaExceededError` and abort with nothing committed.
- Exact-offset corruption detection.
- Deletion scope and bounded listing.

## AUTOMATED DESKTOP Browser Evidence

Both runs reported `Lab matrix finished.`, with every row PASS, REFUSED (as intended), or INFO. The browser console recorded no warnings, errors, or exceptions in either run.

### Storage Test Matrix

Write time runs from `createWritable()` open to `close()` resolution. Durations are **same-host laboratory observations only** and do not represent device or production throughput.

| Test | Requested | Actually written | Block (generate = write) | Write A / B | Range verification | Full streamed verification (B) | Resume |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ST-02 | 1 MiB | 1,048,576 | 1 MiB | 14 / 11 ms | 6/6 PASS | PASS, 4 ms | — |
| ST-03 | 64 MiB | 67,108,864 | 64 KiB | 1,906 / 1,924 ms | 7/7 PASS | PASS, 97 ms | — |
| ST-03 | 64 MiB | 67,108,864 | 1 MiB | 186 / 245 ms | 7/7 PASS | PASS, 80 ms | — |
| ST-03 | 64 MiB | 67,108,864 | 4 MiB | 100 / 103 ms | 7/7 PASS | PASS, 71 ms | — |
| ST-04/05 | 256 MiB | 268,435,456 | 1 MiB | 826 / 793 ms | 7/7 PASS | PASS, 473 ms | reopen probe: see below |
| ST-04/05 | 512 MiB | 536,870,912 | 1 MiB | 1,573 / 1,570 ms | 7/7 PASS | PASS, 1,079 ms | reopen probe: see below |
| ST-04 optional | 1 GiB | 1,073,741,824 | 1 MiB | — / 3,331 ms | 7/7 PASS | PASS, 1,924 ms | reopen probe: see below |
| ST-06 aligned | 128 MiB | 67,108,864 + 67,108,864 | 1 MiB | 604 / 504 ms (both parts) | 7/7 PASS | PASS | boundary 64 MiB: 4/4 PASS |
| ST-06 unaligned | 32 MiB | 16,781,315 + 16,773,117 | 64 KiB | 906 / 789 ms (both parts) | 7/7 PASS | PASS | boundary 16 MiB + 4,099: 4/4 PASS |
| ST-S2 sync handle | 128 MiB | 67,108,864 + 67,108,864 | 1 MiB | 65 + 63 ms in worker (B) | 7/7 PASS | PASS | in-place resume at 64 MiB: 4/4 PASS |
| ST-S3 control | 1 MiB (+1 corrupt byte) | 1,048,577 | 64 KiB | — | FAIL detected at 500,001 (intended) | FAIL detected at 500,001 (intended) | — |

Write open/close each took ≤ 2 ms for fresh files. `close()` did not grow with file size (0.7 ms for 1 GiB). Each range-verification pass read 1.75 MiB (7 × 256 KiB) regardless of file size.

### Test Status

| Test | Status | Evidence / notes |
| --- | --- | --- |
| ST-01 OPFS availability | `AUTOMATED DESKTOP PASS` | See [Browser Evidence](#browser-evidence). |
| ST-02 Small write | `AUTOMATED DESKTOP PASS` | 1 MiB, ranges and every byte verified. |
| ST-03 Medium write | `AUTOMATED DESKTOP PASS` | 64 MiB at 64 KiB, 1 MiB, and 4 MiB blocks. |
| ST-04 Large write | `AUTOMATED DESKTOP PASS` | 256 MiB and 512 MiB in both runs, plus optional 1 GiB in run B, with no whole-file application buffer. |
| ST-05 Random range reads | `AUTOMATED DESKTOP PASS` | See [Random Access Evidence](#random-access-evidence). |
| ST-06 Resume write | `AUTOMATED DESKTOP PASS` | See [Resume Evidence](#resume-evidence). |
| ST-07 Reload persistence | `AUTOMATED DESKTOP PASS` | See [Reload Persistence Evidence](#reload-persistence-evidence). |
| ST-08 Quota reporting | `AUTOMATED DESKTOP PASS` | See [Storage Estimate / Quota Findings](#storage-estimate--quota-findings). |
| ST-09 Persistence request | `AUTOMATED DESKTOP — RECORDED` | See [Persistence API Findings](#persistence-api-findings). A denial is not a failure. |
| ST-10 Explicit deletion | `AUTOMATED DESKTOP PASS` | See [Cleanup Evidence](#cleanup-evidence). |
| ST-11 Insufficient headroom | `AUTOMATED DESKTOP PASS` (simulated) | See [ST-11 Headroom Refusal](#st-11-headroom-refusal). |
| ST-12 Physical Android | `DEFERRED PHYSICAL` | No device attached (`adb devices` empty; no emulator running). Tracked as `DEFERRED-PHYSICAL-004`. |
| ST-S1 `createWritable()` semantics | `AUTOMATED DESKTOP — RECORDED` | See [OPFS Findings](#opfs-findings). |
| ST-S2 Sync access handle (worker) | `AUTOMATED DESKTOP PASS` | See [OPFS Findings](#opfs-findings). |
| ST-S3 Corruption negative control | `AUTOMATED DESKTOP PASS` | A single flipped stored byte was detected by both the range and the full check at absolute byte 500,001. |

## Browser Evidence

The capability table distinguishes API presence from exercised behavior:

| Capability | API | Behavior |
| --- | --- | --- |
| Secure context (`127.0.0.1`) | AVAILABLE | VERIFIED |
| StorageManager | AVAILABLE | VERIFIED (numeric estimate returned) |
| `navigator.storage.estimate()` | AVAILABLE | VERIFIED |
| OPFS `navigator.storage.getDirectory()` | AVAILABLE | VERIFIED |
| `FileSystemFileHandle.createWritable()` | AVAILABLE | VERIFIED up to 1 GiB |
| `FileSystemWritableFileStream.seek()` | AVAILABLE | VERIFIED (resume) |
| `File.slice()` random-access read | AVAILABLE | VERIFIED |
| `removeEntry()` | AVAILABLE | VERIFIED (absence confirmed) |
| `persisted()` | AVAILABLE | VERIFIED (returns `false`) |
| `persist()` | AVAILABLE | VERIFIED (resolves `false`) |
| `createSyncAccessHandle()` (dedicated worker) | AVAILABLE | VERIFIED (128 MiB) |
| Entry survives page reload | n/a | VERIFIED |

ST-01 opened the OPFS root and created the `driftless-spike-04` subdirectory in both runs.

## OPFS Findings

1. **`createWritable()` output is invisible until `close()` (ST-S1).**
   - While a 16 MiB write stream was open, `getFile().size` was 0 B, but `estimate().usage` had already risen by 16 MiB (the swap file).
   - After `close()` the file was 16 MiB.
   - An extension stream that wrote 8 MiB more and then called `abort()` left the file at exactly 16 MiB with every byte intact.
   - **Implication:** bytes received through one long-lived `createWritable()` stream cannot be read back for playback until that stream commits. A progressive design must commit in bounded units, for example per-segment entries or periodic close-and-reopen, or else use a sync access handle.
2. **`keepExistingData` resume copies the existing file.**
   - Opening a keep-existing stream took 295 / 329 ms for 256 MiB, 630 / 641 ms for 512 MiB, and 1.24 s for 1 GiB. A fresh open took 5–30 ms.
   - While the stream was open, usage rose by the full existing size: 268,435,656, 536,871,112, and 1,073,742,026 bytes respectively.
   - **Implication:** resuming a multi-GB entry through `createWritable()` costs O(existing size) time and temporarily doubles disk use. That is why the spike's admission policy uses a 2× factor.
3. **`FileSystemSyncAccessHandle` writes in place (ST-S2).**
   - In a dedicated worker, 64 MiB was written with a flush every 16 MiB. The handle was held open, and 7 ranges were read back and verified through the same handle.
   - The main thread's `getFile()` then reported 64 MiB and **verified 7 ranges while the worker still held the handle**.
   - With the handle held, main-thread `createWritable()` failed with `NoModificationAllowedError`. A second sync handle failed with `NoModificationAllowedError`: "Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file".
   - After release, the in-place resume at 64 MiB opened in 1.6 ms with no copy. Boundary, range, and full-file checks passed.
   - **Implication:** one writer holds an exclusive lock, readers can still see flushed data, and resume cost does not scale with file size. This is the more suitable candidate path for progressive receive-while-play, but it requires a worker.
4. **Write-call overhead dominates small blocks.** A 64 MiB write took about 1.9 s at 64 KiB blocks, about 0.19–0.25 s at 1 MiB, and about 0.10 s at 4 MiB. Spike 0.3 transport chunks are 16–128 KiB. A later design should aggregate transport chunks into larger storage writes or use the sync handle; per-chunk `createWritable().write()` calls are likely to be costly. This is a same-host observation only, and small-block sync-handle throughput was not measured.
5. Close time did not grow with file size for fresh writes (≤ 2 ms at 1 GiB). Chromium appears to commit a fresh swap file by move rather than copy; this was inferred, not inspected.

## Random Access Evidence

Every written file was read at 6–7 selected 256 KiB ranges: beginning, quarter, middle, an unaligned interior offset, three-quarter, near end, and end. For the 1 GiB file, the ranges were at offsets 0, 268,435,456, 536,739,840, 654,982,515 (unaligned), 805,306,368, 1,073,475,581, and 1,073,479,680.

- All ranges matched in both runs.
- Each range read took 0.8–1.5 ms, independent of its distance into the file.
- Each pass read 1.75 MiB, not the whole file.

This approximates a player requesting a distant segment without reading the whole cached object.

## Resume Evidence

**Aligned (128 MiB):**

1. Wrote 0–64 MiB and closed.
2. Re-opened the file through a fresh `getDirectory()` → directory → file-handle lookup. It reported 67,108,864 bytes.
3. A resume at stored size + 4 KiB was refused (`RangeError`) before any stream opened.
4. Resumed at exactly 67,108,864 with `keepExistingData: true` and `seek()`. The open took 74.8 ms: the 64 MiB copy.
5. Wrote to 128 MiB and closed.

Verification passed on the 128 KiB range straddling the boundary, the last byte before it, the first byte after it, and a 7-byte unaligned window. All 7 selected ranges and every byte of the file also passed.

**Unaligned (32 MiB, 64 KiB blocks):** used the boundary 16,781,315 (16 MiB + 4,099), which is not a multiple of 4 or of the block size. Stored size after reopen: 16,781,315. All boundary, range, and full checks passed.

**Sync handle:** resumed in place at 64 MiB after release, with no copy. All checks passed.

No corruption appeared at any resume boundary in either run.

## Reload Persistence Evidence

1. A 64 MiB `persist-64m-…` entry and its 146-byte schema-checked metadata sidecar were written and verified.
2. The profile's `File System` directory measured about 64 MiB on disk.
3. The driver issued a CDP `Page.reload`. The reloaded page reported navigation type `reload` and listed both entries.
4. **Verify stored entries** re-opened OPFS, parsed the metadata, located the entry by name, confirmed 67,108,864 bytes, and verified 7/7 ranges and every byte using the stored seed.

This passed in both runs. It establishes survival across an ordinary same-session page reload only. It does **not** establish survival across browser restart, tab discard, profile cleanup, storage pressure, or eviction.

## Storage Estimate / Quota Findings

- Estimates were accurate to the byte for these writes.
  - `estimate()` returned a numeric `quota`, `usage`, and a non-standard `usageDetails.fileSystem`.
  - Usage rose by exactly the bytes written plus a few hundred bytes of metadata (1 MiB → +1,048,758 B; 1 GiB → +1,073,742,012 B).
  - Usage returned to the 182-byte baseline after each deletion.
- Usage included uncommitted swap data (ST-S1) and the keep-existing copy, so the estimate reflects transient double-counting during writes.
- Reported quota was **10.00 GiB, and it behaved as `usage + 10 GiB`**:
  - 10,737,418,422 with 182 B used;
  - 10.06 GiB with 64 MiB used;
  - 10,737,418,240 with 0 B used.
- This was far below the 596 GiB free on the host volume and is a property of this headless, throwaway-profile environment. It must not be generalized. Quota for a normal profile, other browsers, and Android was not measured.

## Persistence API Findings

- `persisted()` returned `false` initially and after the request.
- The page called `persist()` once, on an explicit control. It resolved `false` in about 1.3 ms with no prompt.
- Chrome decides persistence through heuristics, not user prompts, so a fresh `127.0.0.1` origin in a throwaway profile was not granted.
- The product must not assume persistence will be granted. Without it, OPFS data remains best-effort and evictable under storage pressure.
- Other browsers were not tested.

## Memory Findings

- **Block sizes:**
  - Generation and write used one reused block of 64 KiB, 1 MiB, or 4 MiB, allocated once per write operation. Each block was awaited before the buffer was refilled. The unit tests confirm a single underlying buffer.
  - Range verification read 256 KiB per range.
  - Full verification read 1 MiB per `slice().arrayBuffer()`.
- **Measured (coarse, headless Chrome):**
  - CDP `Runtime.getHeapUsage` sampled every 250 ms across run B's matrix: V8 heap used ≤ 2.8 MB throughout, while ArrayBuffer backing storage peaked at about 128 MB.
  - `performance.memory.usedJSHeapSize`, which includes that backing storage, peaked at 129 MB.
  - The write phase added essentially nothing. The 1 GiB write began and peaked at 78.8 MiB.
  - The backing-storage growth came from the verification reads, whose short-lived 1 MiB result buffers awaited garbage collection.
  - After a forced GC at the end of the matrix: 1.1 MB heap and 79 KB backing storage. Nothing was retained.
- Peaks did not track file size: ≈ 84 MiB at 256 MiB, 103 MiB at 512 MiB, 125 MiB at 1 GiB, with carry-over from earlier tests. The application never held a complete test file in memory.
- Browser-process and OPFS-backend memory were **not** measured. No exact memory-consumption claim is made.
- Production readers should reuse read buffers, for example sync-handle `read()` into a preallocated buffer, to avoid GC-dependent transient growth, especially on Android.

## Cleanup Evidence

- **Every test** deleted its entry and confirmed absence via `NotFoundError` on lookup. Usage returned to the baseline after each deletion.
- **ST-10:** created a 1 MiB entry plus its metadata, deleted both, and confirmed both absent. The page refused to delete `../not-a-spike-entry`.
- **Clear Spike Storage** ran after the matrix and again after ST-07. It removed `driftless-spike-04` recursively and confirmed its absence.
  - Final state: OPFS root listing `[]`.
  - `estimate()` usage 0 B.
  - The profile's `File System` directory shrank from about 64 MiB to 52 KB of browser bookkeeping.
- Each throwaway profile was deleted after its run, with removal confirmed.

## ST-11 Headroom Refusal

ST-11 did not exhaust real storage. Refusal was verified in two ways.

In the browser, three requests were refused before any file was created (entry count before 0, after 0):

| Request | Estimate / condition | Result |
| --- | --- | --- |
| 256 MiB | Simulated 900 MiB headroom (policy needs 1.5 GiB) | `INSUFFICIENT STORAGE HEADROOM` |
| 256 MiB | Simulated missing `estimate()` values | `INSUFFICIENT STORAGE HEADROOM` |
| 2 GiB | Above the 1 GiB spike cap | `SIZE OUT OF BOUNDS` |

The unit tests additionally cover a real mid-write `QuotaExceededError` path. It aborts the stream with nothing committed.

## Emulator Evidence

None. No emulator was running and none was started.

## Physical Android Evidence

None. `DEFERRED PHYSICAL` as `DEFERRED-PHYSICAL-004`.

## Compatibility Findings

| Capability | Chrome 153 desktop (headless, macOS) | Edge / Firefox / Safari / Android |
| --- | --- | --- |
| StorageManager | `SPIKE ONLY` — behavior verified | `NOT TESTED` |
| Storage estimate | `SPIKE ONLY` — numeric, byte-accurate usage; quota environment-specific | `NOT TESTED` |
| OPFS (`getDirectory`, `createWritable`, `seek`, `removeEntry`) | `SPIKE ONLY` — behavior verified to 1 GiB | `NOT TESTED` |
| Sync access handle (worker) | `SPIKE ONLY` — behavior verified to 128 MiB | `NOT TESTED` |
| Persistence API | `SPIKE ONLY` — present; `persist()` not granted in this environment | `NOT TESTED` |
| Random-access reads | `SPIKE ONLY` — verified | `NOT TESTED` |

`docs/COMPATIBILITY.md` was intentionally not changed. Earlier spikes did not change it, and one headless desktop engine does not justify a compatibility-status change.

## Security / Privacy Verification

- **Local only:** all data was generated in the page and stored in the origin-private file system.
  - The CSP sets `connect-src 'none'`.
  - The CDP network log for both runs contains only same-origin `GET`s of the page's own static files. The worker is included; `framing.mjs` is the only file served from outside the spike directory.
  - There is no upload endpoint, no analytics or telemetry, and no server persistence.
- **Origin-private:** OPFS is not the user-visible filesystem. The page has no file picker, download, or `showSaveFilePicker` path, so test data cannot escape into arbitrary user filesystem locations through the experiment.
- **Scoped operations:** every operation stays inside one subdirectory under internally generated, regex-validated names.
  - Deletion refuses names that fail validation.
  - Clear removes only the spike directory.
  - Stored names are rendered through `textContent` after bounding and control-character replacement.
  - Metadata read back is size-bounded and schema-checked. The tests reject path-like names, invalid seeds, and out-of-bounds sizes.
- **Bounded requests:** sizes are bounded to 1 MiB–1 GiB, blocks to 4 KiB–16 MiB, ranges to ≤ 16 MiB, listings to 100 entries, and metadata to 4,096 characters.
- **Important fact:** OPFS isolation from the ordinary filesystem is not confidentiality. Cached media is still sensitive local data.
  - Any script on the same origin can read it.
  - It sits unencrypted in the browser profile on disk.
  - It persists until deleted or evicted.
  - Shared-device and browser-profile exposure apply.

  Production cache design must provide explicit cleanup, identity-scoped entries, and lifecycle rules, as `docs/SECURITY.md` already requires.

## Risks / Issues

- The `createWritable()` commit-on-close and O(n) keep-existing copy make a single long-lived stream unsuitable for progressive receive-while-play. The sync handle avoids both but needs a worker and holds an exclusive lock.
- Resume by stored size alone is not sufficient for production. After a crash or reload, uncommitted `createWritable()` data is lost, and flushed-but-unverified sync-handle data needs its own verified-range metadata. Resume must reconcile against verified ranges, as `docs/MEDIA_PIPELINE.md` already anticipates.
- Quota observations came from a headless throwaway profile (10 GiB cap). Multi-GB behavior on normal profiles and on Android storage, and eviction under pressure, are untested.
- Persistence was not granted, so eviction remains possible and must be handled.
- Transient read-buffer garbage reached about 128 MB on desktop before GC. It is untested on memory-constrained mobile devices.
- Only one engine and one host were tested. Edge, Firefox, Safari, and Android behavior are unknown.
- Browser restart, tab discard, backgrounding, and concurrent-tab access were not tested.

## Deferred Physical Tests

`DEFERRED-PHYSICAL-004 — Spike 0.4 Android Chrome OPFS/storage qualification`. On physical Android Chrome, repeat:

- ST-01 to ST-11 with representative sizes;
- the sync-handle path;
- quota and estimate behavior;
- `persist()` outcome;
- eviction and background/tab-discard behavior;
- storage-full handling;
- read-buffer memory behavior.

Record device model, OS, browser version, and free storage.

Earlier debts `DEFERRED-PHYSICAL-001` to `-003` remain open and unchanged.

## Decision

Record `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`.

- Every acceptance criterion has current desktop evidence.
- A 256 MiB write was exercised, and 512 MiB and 1 GiB also passed.
- The persistence denial does not fail the spike.
- Full `PASS` awaits physical Android evidence.

## Architecture Impact

No architecture change required. OPFS remains a viable candidate for the planned cache/storage component. No ADR was modified.

The measured write-API semantics are inputs to later transfer-engine and cache design, not ADR challenges:

- `createWritable()` commits on close and copies on keep-existing resume.
- Sync handles are in-place and lock exclusively.
- Small writes carry high per-call overhead.

Alternatives remain open until the integration spikes: per-segment entries, sync-handle worker, or layered memory/OPFS.

## Follow-up

Independent review of Spike 0.4 before beginning Spike 0.5.
