# Field conditions — test procedures

`CLAUDE.md` names eight field conditions and requires that **each has either
an automated test or a documented manual procedure**. This file is that
record.

The distinction it keeps throughout is between *logic that is tested* and
*behavior that is verified*. This repo has a lot of the first and none of
the second: 211 assertions pass on a machine with no device, no native
toolchain, and no model file. Every one of them exercises a reducer or an
orchestrator against fakes. **None of them prove the library works on a
phone**, because nothing here has ever run on one.

So each condition below lists what is genuinely covered today, what that
coverage explicitly does *not* prove, and the manual procedure to run once
hardware exists. Where a condition is blocked on unwritten code rather than
just on unavailable hardware, that's stated — a manual procedure for a
feature that doesn't exist would be fiction.

## Status at a glance

| # | Condition | Logic tested | Behavior verified | Blocked on |
|---|---|---|---|---|
| 1 | Airplane mode toggled mid-download | Yes | No | M0 + device |
| 2 | Disk fills during download | Partly | No | M0 + device |
| 3 | App force-quit mid-download, then relaunched | Partly | No | **Unwritten persistence layer**, then M0 |
| 4 | App backgrounded mid-generation | No | No | **M1 — generation does not exist** |
| 5 | Second model requested while the first is loading | Yes | No | M1 + device |
| 6 | 4 GB Android device, camera-induced memory pressure | Preflight only | No | **Unwritten pressure subscription**, then M0 |
| 7 | Thermal throttling during sustained generation | No | No | **M1 — generation does not exist** |
| 8 | Corrupted model file on disk | Yes | No | M0 (hashing has never run) |

Three of the eight (4, 7, and the second half of 6) cannot have a procedure
worth writing yet, because the code they would exercise has not been
written. Those sections say what would have to exist first.

## Prerequisites for any manual run

None of these can be run today. When they can, all of them need:

- A physical device. **No simulator results count** — `CLAUDE.md` is explicit
  about this, and simulators misrepresent memory pressure, thermal behavior,
  and background execution, which is most of what's being tested here.
- Both an iOS device and a 4 GB-class Android device. Android is the target,
  not a flagship; several of these conditions only bite on the low end.
- The `/example` Expo dev-client app (M4 in the milestone list, but needed
  well before that to run any of this), wired to log every `onStateChange`
  transition with a timestamp.
- A real model file of realistic size — roughly 1.2 GB. Small test files
  hide timing, memory, and background-execution problems entirely.
- A manifest whose `sha256` is genuinely correct, so a mismatch means a real
  failure rather than a bad fixture.

---

## 1. Airplane mode toggled mid-download

**Why it matters:** the single most common real-world interruption, and the
one the resume path exists for.

**Covered today:**
- `download.test.ts` — `carries an underlying cause (e.g. airplane mode /
  lost connectivity)`, `after a transport interruption, resumes from
  bytesDownloaded`, `interrupted then resumed, then a checksum failure forces
  a full restart`
- `downloadModel.test.ts` — `retries resuming from the bytes already on
  disk`, `resumes from progress reported before the interruption`,
  `preserves the underlying cause`, `stops after maxAttempts rather than
  retrying forever`

**Not proven:** that `expo-file-system`'s `DownloadTask` actually *rejects*
when the radio drops, rather than hanging or silently stalling — the
orchestrator's retry logic never runs if the transport never settles. Also
unproven: that the partially transferred bytes are still on disk afterwards,
and that resuming issues a real HTTP range request the server honors rather
than silently restarting from zero.

**Procedure:**
1. Start a download of the full-size model over Wi-Fi.
2. Wait until `onStateChange` reports roughly 30–40% progress. Record
   `bytesDownloaded`.
3. Enable airplane mode.
4. Observe the state transition. Expect `failed` carrying a
   `DownloadInterruptedError` whose `bytesDownloaded` matches step 2 —
   **within a few seconds, not minutes**. A long stall here is the failure
   mode to watch for.
5. Disable airplane mode, and retry.
6. Watch the server-side or proxy request log.

**Pass criteria:**
- The interruption surfaces as a typed `DownloadInterruptedError`, not a raw
  native rejection.
- The retry issues a `Range:` request starting at the recorded byte offset —
  confirm in the request log, not just by watching the progress bar.
- Total bytes transferred across both attempts is meaningfully less than
  twice the file size. If it silently re-downloaded everything, resume is
  not working even though the download "succeeded."
- Final checksum verifies and the file lands at its destination.

---

## 2. Disk fills during download

**Why it matters:** a 1.2 GB write on a nearly-full phone is a routine
occurrence, not an edge case.

**Covered today:**
- `diskGuard.test.ts` — all 11 assertions, covering the precheck's headroom
  and resume arithmetic
- `downloadModel.test.ts` — `rejects with InsufficientDiskSpaceError when
  there is not enough room`, `never starts a transfer it knows cannot
  finish`, `does not retry a disk-space failure — retrying cannot create
  space`, `a failed move does not report success`

**Not proven:** everything about the *mid-transfer* case. The precheck only
runs once, before the first byte; if another app consumes the space
afterwards, the download hits a genuine `ENOSPC` from the transport, and what
`expo-file-system` rejects with in that situation is unknown. It is currently
wrapped as `DownloadInterrupted`, which would make the orchestrator *retry* a
condition that retrying cannot fix — plausibly the wrong behavior, but not
yet observable. Also unproven: that `freeDiskBytes()` (no implementation
exists yet) reports what the OS actually enforces, which on iOS differs
between "available" and "available for important usage."

**Procedure:**
1. Fill the device so free space is comfortably above the model size —
   enough to pass the precheck, but not by much.
2. Start the download.
3. At roughly 50%, write a large dummy file from another app (or `adb shell
   dd` on Android) until free space is exhausted.
4. Observe the state transitions and the resulting error.
5. Separately: attempt a download when free space is *below* the model size
   plus headroom, to confirm the precheck refuses before any transfer starts.

**Pass criteria:**
- The pre-start case raises `InsufficientDiskSpaceError` and **issues no
  network request at all** — verify in the request log.
- The mid-transfer case surfaces a typed error, never a crash.
- No partially written file is left at the *destination* path in either case.
- Record what the mid-transfer error actually is. If it retries repeatedly
  against a full disk, that is a real bug and this condition should be
  reopened with a fix that distinguishes `ENOSPC` from a transport blip.

---

## 3. App force-quit mid-download, then relaunched

**Why it matters:** `CLAUDE.md`'s downloader spec requires surviving this. On
a 20-minute download it is close to inevitable.

**Covered today:**
- `download.test.ts` — `force-quit mid-download: a fresh state machine can
  resume from persisted progress`, `resumeFromBytes seeds bytesDownloaded,
  modeling a resume after force-quit`
- `downloadModel.test.ts` — `passes resumeFromBytes through to the transport
  on a fresh resume`

**Not proven — and this one is an implementation gap, not just a test gap.**
Both tests above prove the *shape* of a resume is correct if someone hands
back a byte offset. **Nothing in this repo persists that offset.** The
reducer holds it in memory, and memory is exactly what a force-quit destroys.
`downloadTransport.ts`'s `pauseForBackground()` returns a
`PersistedTransferState` intended for this, but nothing calls it, nothing
writes it to durable storage, and nothing reads it back on launch. Until
that host layer exists, this condition **will fail** — not intermittently,
but always, restarting from zero every time.

`DownloadTask.savable()` / `fromSavable()` have also never been executed, so
whether the resume token survives process death at all is unknown.

**Before this can be run, someone must build:** a durable store for
`PersistedTransferState` + `bytesDownloaded` (written on progress, or at
minimum on app-background), and launch-time logic that reads it back and
passes it to `downloadModel()` as `resumeFromBytes`.

**Procedure (once that exists):**
1. Start a download of the full-size model.
2. At roughly 40%, force-quit from the app switcher — not a graceful
   background, a genuine kill.
3. Confirm the persisted state is on disk and records a sensible byte count.
4. Relaunch and trigger the same download.
5. Repeat with a force-quit during the *verifying* phase, after the transfer
   completes but before the move.

**Pass criteria:**
- The relaunched download resumes near the recorded offset, and the request
  log confirms a range request.
- The force-quit-during-verify case does not leave a corrupt file at the
  destination — it should re-verify or re-download, never promote unverified
  bytes.
- The final file's SHA-256 matches the manifest. **Hash the resulting file
  independently** — a resume that stitches bytes incorrectly is exactly the
  failure the checksum exists to catch, so do not treat "it downloaded" as
  the pass condition.

---

## 4. App backgrounded mid-generation

**Blocked: generation does not exist.** No `InferenceBackend`, no
`generate()`, no streaming. This is M1 work at the earliest.

**Covered today:** nothing, and nothing could be. There is no code path to
test.

**What must exist first:** a backend that can load a model and stream tokens,
plus the JSI streaming callback described in `CLAUDE.md`, plus the
unload-on-background behavior (also unwritten).

**Sketch of the eventual procedure**, recorded so it isn't re-derived later:
start a long generation, background the app mid-stream, wait past the point
where the OS suspends the process, then foreground it. The questions to
answer are whether native resources were released on background, whether the
generation resumes or cleanly reports cancellation, and — critically —
whether anything crashes or leaks when the JSI callback's JavaScript context
is no longer live. That last one is the real risk and the reason this
condition is on the list.

---

## 5. Second model requested while the first is loading

**Why it matters:** locked decision #4 — one model resident at a time — is
the memory contract, and this is the race that breaks it.

**Covered today, and this is the best-covered condition on the list.** The
first test below is named verbatim after this line in `CLAUDE.md`:
- `loadLock.test.ts` — `second model requested while the first is loading
  (the documented test scenario)`, `a second model requested while the first
  is loading displaces it`, `loading a second model while the first is fully
  resident unloads the first`, `throws if only loading (must cancel
  instead)`

**Not proven:** that the displacement actually frees native memory. The load
lock is a reducer over model *ids*; it returns `modelToUnload` to tell a host
when to issue a native unload, but no such host exists, and no native unload
exists to issue. It also cannot prove that the displaced load's pending
promise is rejected with `CancelledError('load')` — that too is host code
that hasn't been written.

**Procedure (once M1 provides real loading):**
1. On the 4 GB Android device, begin loading a large model.
2. Before it completes, request a different model.
3. Watch native memory (Android Studio Profiler, or Xcode Instruments on
   iOS) across the whole sequence.
4. Repeat with the second request issued at several points: immediately,
   mid-load, and just as the first load completes — the last is the tightest
   race and the most likely to expose a leak.

**Pass criteria:**
- Peak native memory never reflects two models resident at once. This is the
  contract; a transient spike overlapping both is a failure even if nothing
  crashes.
- The first load's promise rejects with `CancelledError('load')`.
- The second model loads successfully and generates.
- Memory returns to baseline after unloading. Run the sequence ten times and
  confirm no upward drift — a small per-cycle leak is invisible in one run
  and fatal in a long session.

---

## 6. 4 GB Android device, memory pressure induced by opening the camera

**Why it matters:** `CLAUDE.md` calls the memory guard "the part most likely
to earn the library its reputation," and names this exact scenario as the
target.

**Covered today:**
- `memoryGuard.test.ts` — all 5 assertions, covering the preflight decision
  and its headroom margin

**Not proven:** almost everything that matters here. `checkMemoryCapability()`
is pure arithmetic over a number someone hands it; **nothing reads actual
device RAM** (that's `getDeviceCapabilities()`, M0, unwritten). The OS
memory-pressure subscription is unwritten. Unload-on-background is unwritten.
So the guard currently cannot refuse a load on a real device, cannot react to
pressure, and cannot unload proactively — the three things this condition
exists to test.

**What must exist first:** `getDeviceCapabilities()` returning real available
RAM; a memory-pressure subscription (`onTrimMemory` / `ComponentCallbacks2`
on Android, `didReceiveMemoryWarning` on iOS); and the proactive unload path.

**Procedure (once those exist):**
1. On a genuine 4 GB Android device, load a model sized to fit but without
   much margin.
2. Start a sustained generation.
3. Open the camera app — the highest-pressure common trigger.
4. Return to the app.
5. Repeat with a model whose `minRamBytes` exceeds what's actually available,
   to confirm the preflight refuses rather than attempting the load.

**Pass criteria:**
- The app is not killed by the OS low-memory killer. This is the headline
  criterion; everything else is secondary.
- The pressure signal is received and the model unloaded proactively, with
  the unload observable in a log.
- Returning to the app produces a clear state — either a reloaded model or a
  typed `InsufficientMemory` error — never a silent hang or a stale handle
  pointing at freed memory.
- The over-large model is refused with `InsufficientMemoryError` **before**
  any native allocation. A crash here means the guard failed at its one job.

---

## 7. Thermal throttling during sustained generation

**Blocked: generation does not exist.** Same as condition 4.

**Covered today:** nothing, and nothing could be.

**Sketch of the eventual procedure:** run continuous generation for 10+
minutes on a device with no active cooling, recording tokens/sec and the
thermal state (`ProcessInfo.thermalState` on iOS,
`PowerManager.getCurrentThermalStatus()` on Android) throughout. The point is
not to prevent throttling — that isn't possible — but to confirm the library
degrades predictably rather than crashing, stalling indefinitely, or
reporting a misleading rate. Results belong in `/benchmarks` as committed
JSON alongside the tokens/sec numbers, since a benchmark taken before thermal
saturation is misleading on its own.

---

## 8. Corrupted model file on disk

**Why it matters:** "never trust a downloaded file that fails checksum" is a
stated rule, and this is the test of it.

**Covered today:**
- `checksum.test.ts` — `throws ChecksumMismatchError when hashes differ,
  flipping a single byte` (literally the byte-flip this condition names)
- `downloadModel.test.ts` — `never moves bad bytes into place`, `deletes the
  temp file so a retry cannot re-verify the same bad bytes`, `retries from
  byte zero, not from the bytes that failed`, `rejects with
  ChecksumMismatchError carrying both hashes once attempts run out`

**Not proven:** that the hash is ever computed correctly, because
`hashing.ts` has never run. `computeSha256()` typechecks against the real
`expo-file-system` and `react-native-quick-crypto` `.d.ts` files, and that is
the entire extent of its verification. The comparison logic being correct is
worth little if the value fed into it is wrong. Also unproven: that streaming
a 1.2 GB file through `File.stream()` into `createHash()` completes in
acceptable time without exhausting memory — the chunked design exists
precisely to avoid that, and the design has never been exercised.

**Procedure:**
1. Complete a successful download so a verified model file is in place.
2. Compute its SHA-256 with an independent tool (`shasum -a 256`, pulled via
   `adb pull` or the iOS file container) and confirm it matches both the
   manifest and what `computeSha256()` reported. **Do this before the
   corruption test** — it is the only check that the hashing implementation
   is correct at all, and it is the most valuable step in this procedure.
3. Time that hash computation and record peak memory.
4. Flip a single byte in the middle of the file (`printf '\\x00' | dd
   of=model.gguf bs=1 seek=600000000 conv=notrunc`) and push it back.
5. Trigger a load, or re-run verification against the modified file.

**Pass criteria:**
- Step 2 matches exactly. A mismatch means every checksum result so far is
  meaningless.
- Hashing 1.2 GB completes in a reasonable time and peak memory stays far
  below the file size — proving the stream is genuinely chunked and not
  buffering the whole file.
- The flipped byte is caught, producing `ChecksumMismatchError` with both
  hashes populated.
- The corrupt file is never handed to a backend for loading.

---

## Recording results

When these are run, record for each: device model, OS version, available
RAM, the library commit, and the observed result against each pass criterion.
Failures are more valuable than passes here — a documented failure with the
device and conditions attached is the input to a fix, whereas "it worked on
my phone" is not evidence about the 4 GB Android device this library is
actually for.

Benchmark numbers from conditions 6 and 7 belong in `/benchmarks` as
committed JSON per `CLAUDE.md`: device, model, quantization, tokens/sec, peak
RSS, time-to-first-token. Real devices only.
