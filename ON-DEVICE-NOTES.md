# On-device transcription on iPhone — working notes

A running log of a fork of [thewh1teagle/vibe](https://github.com/thewh1teagle/vibe) (MIT)
that teaches the phone PWA to transcribe by itself, offline, with no desktop and
no App Store.

Written to survive a restart. If you are picking this up cold — or handing it to
an assistant in a fresh session — read **Current state** and **Hard-won facts**
first. The facts section is the valuable part: most of it was established by
running things and being wrong, not by reading docs.

Last updated: 2026-09-16

---

## Where everything is

|                                  |                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Fork                             | <https://github.com/iznavibe/vibe>                                           |
| Branch                           | `offline-on-device` (all work is here; `main` is untouched upstream)         |
| Local clone                      | `C:\Users\FD\Documents\vibe-phone`                                           |
| Live app                         | <https://iznavibe.github.io/vibe/>                                           |
| Upstream remote                  | `upstream` → `thewh1teagle/vibe`                                             |
| Installed app being reverse-engineered | `C:\Users\FD\AppData\Local\vibe`                                       |
| Desktop config + models          | `%APPDATA%\github.com.thewh1teagle.vibe`, `%LOCALAPPDATA%\github.com.thewh1teagle.vibe` |

GitHub Pages is enabled on the fork with the **GitHub Actions** source. The
`github-pages` environment originally allowed only `main`; `offline-on-device`
was added to its branch policy, or deploys are rejected *after* a successful
build.

## The goal

Transcribe on the iPhone itself, fully offline. No App Store, no paid developer
account, no signing. That ruled out a native app and pointed at the PWA that
already ships in `handoff/pwa/`.

## What the original app is

Not source — `AppData\Local\vibe` is an installed Tauri app. The binaries still
carry Rust debug paths, so the architecture reads straight out of them:

```
vibe.exe                     Tauri shell (React UI) — desktop/src-tauri/src/
 ├─ spawns vibe-server.exe   Axum HTTP server, /v1/... with a Swagger UI
 │    ├─ whisper-rs → ggml-rs-sys   (whisper.cpp; CPU + Vulkan)
 │    ├─ parakeet-rs, nemotron-rs   (alternative ASR models)
 │    ├─ vad-rs                     (Silero, shipped as ggml-silero-v6.2.0.bin)
 │    └─ diarize-rs                 (segmentation-3.0.onnx + wespeaker CAM++)
 ├─ spawns ffmpeg.exe / ffprobe.exe / yt-dlp.exe / sona-diarize.exe
 └─ handoff/  ← iroh QUIC p2p →  PWA at thewh1teagle.github.io/vibe/phone
```

The key structural fact: **it is a multi-process design**. iOS forbids spawning
executables, so a native port would have had to collapse four binaries into
in-process libraries. That is what made the PWA the cheaper path — not a
compromise.

`handoff/` was already a PWA talking to the desktop over iroh, doing the
"record here, transcribe there" half. This whole project is adding the other half.

## What was built

Five commits on `offline-on-device`:

```
a55b105e  Stop using WebGPU on WebKit, which is what was killing the app
9b2dedbb  Fix the on-device model sizes that were killing the app
c07b8579  Import audio and video from the library, not just recordings
b01420c7  Deploy the phone PWA to this fork's Pages
be849333  Add on-device transcription to the phone PWA
```

### The integration idea worth keeping

`useHandoffSession` already drove a transcription by reading a
`ReadableStream<HandoffEvent>`. That loop is specific to the **event shape**, not
to iroh. So the local engine emits the *same* stream and the session cannot tell
which one it is reading — progress, segments, transcript accumulation and the
durable outbox all work untouched.

If you change one engine, keep the event contract identical or this collapses.

### New files (`handoff/pwa/src/lib/local/`)

| File              | Role                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `audio.ts`        | Decode to 16 kHz mono via Web Audio. Replaces the ffmpeg sidecar a phone cannot spawn. |
| `worker.ts`       | The transformers.js pipeline, off the main thread.                       |
| `engine.ts`       | Adapts the worker onto the `HandoffEvent` stream.                        |
| `models.ts`       | Model list, per-backend quantisation variants, cache checks.             |
| `backend.ts`      | Chooses WebGPU vs WASM. **Read the comment before touching.**            |
| `progress.ts`     | Chunk offsets made absolute and monotonic.                               |
| `import.ts`       | File picking, duration probe, the 30-minute cap.                         |
| `crash.ts`        | Breadcrumb that survives an OOM kill so the app can explain itself.      |
| `capabilities.ts` | Whisper's 99 languages, shaped as a `Capabilities` reply.                |

Plus `scripts/copy-ort.mjs`, `scripts/fetch-wasm.mjs`, and four test files (48 tests).

---

## Hard-won facts

Everything here cost something to learn. Do not re-derive it.

### 1. ORT's WebGPU path kills Safari

ORT's WebGPU execution provider is **JSEP**. On WebKit 26 it sends the content
process into a compilation loop — CPU pinned, memory past a gigabyte, process
killed outright on iOS. A single Whisper load is enough.

- <https://github.com/microsoft/onnxruntime/issues/26827> (open, no fix)
- <https://github.com/huggingface/transformers.js/issues/1242>

Symptom on the phone: spins 2–5 s, vanishes to the home screen, sometimes
"a problem repeatedly occurred". **Every browser on iOS is WebKit**, so there is
no dodging it by switching browsers.

`backend.ts` forces the plain WASM build on WebKit and keeps WebGPU elsewhere.
Detection is by capability (`GestureEvent` in `window`), not user agent, because
Chrome on iOS is WebKit underneath and crashes identically.

**If `device: 'webgpu'` is ever set unconditionally again, iOS will crash again.**

### 2. Quantisation is not portable across backends

On the **CPU/WASM** backend, with `onnx-community/whisper-*`:

| dtype (encoder / decoder) | result                                          |
| ------------------------- | ----------------------------------------------- |
| `fp16` / anything         | ❌ fails — `Missing required scale … MatMulNBits` |
| any / `q8`                | ❌ fails — same                                  |
| `q8` / `q4`               | ✅ works                                         |
| `q8` / `fp32`             | ✅ works                                         |
| `fp32` / `fp32`           | ✅ works, large                                  |

On **WebGPU**, `fp16` encoder + `q4f16` decoder is both smaller and faster.

Each model therefore carries a per-backend variant in `models.ts`. These were
found by running every combination in a browser, not by reading anything.

### 3. Model sizes must be measured, never estimated

The first crash was self-inflicted: `large-v3-turbo` was configured with
`encoder_model: 'fp16'`, which resolves to `encoder_model_fp16.onnx` —
**1215 MB** — against an advertised 600 MB. Real total ~1.4 GB.

dtype → filename suffix (verified in the bundle):
`fp32:""`, `fp16:"_fp16"`, `q8:"_quantized"`, `q4:"_q4"`, `q4f16:"_q4f16"`.

Check a size before trusting it:

```sh
curl -s "https://huggingface.co/api/models/onnx-community/whisper-large-v3-turbo?blobs=true" \
  | python -c "import json,sys; d=json.load(sys.stdin); [print(round((f.get('size') or 0)/1048576,1), f['rfilename']) for f in d['siblings'] if f['rfilename'].endswith('.onnx')]" \
  | sort -rn
```

### 4. transformers.js fetches ORT from a CDN unless you stop it

Left alone it sets `wasmPaths` to
`cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/`. The service worker only
caches **same-origin** requests, so the runtime came off the network on every
cold start — **offline would have failed regardless of everything else.**

`scripts/copy-ort.mjs` vendors both binaries into `public/ort/` (gitignored,
copied automatically by `prebuild`/`predev`), and `worker.ts` sets `wasmPaths`
explicitly. Resolve that URL against `import.meta.env.BASE_URL`, **not**
`self.location` — the worker is served from `assets/`, so a relative resolve 404s.

Note also that `IS_SAFARI` inside transformers.js already picks the non-asyncify
binary; asking for `webgpu` against it is a mismatch. Backend and binary must
agree, which is why both are chosen in one place.

### 5. Whisper's chunk offsets are window-relative

`WhisperTextStreamer.on_chunk_start` reports the offset within the current 30 s
window, not the recording. A 47.6 s clip reports `0…29, 1…27`. Dividing by total
duration makes the bar climb past halfway and jump backwards. `progress.ts`
carries a base across resets and clamps monotonic.

Final `chunks` timestamps **are** absolute, so SRT export is viable.

### 6. The service worker must not blanket cache-bust `.wasm`

The original rule was `pathname.includes('/wasm/') || pathname.endsWith('.wasm')`
— meant for the handoff bundle during development, but it also caught ORT's
runtime, the single largest thing needed offline. Now scoped to `/wasm/` only.
(`/ort/...wasm` deliberately does not match.)

Also: the SW caches any `res.ok` response, and **204 counts as ok** — a blocked
request got cached as a valid empty asset during testing.

### 7. iOS storage

Model weights live in the **Cache API**, cache name `transformers-cache`, inside
the **installed web app's own WebKit container** — separate from Safari's. Hence:
**Add to Home Screen before downloading anything**, or it downloads twice.

Home-screen web apps are exempt from Safari's 7-day ITP eviction and get a
browser-tier quota (~60 % of disk per origin since Safari 17). A plain tab is not.

### 8. Imports run transiently, not through the outbox

The outbox exists because a recording is the phone's only copy until a transcript
returns. An imported file still sits in the library, so copying gigabytes of video
into IndexedDB protects nothing and blows the 300 MB cap. `send` takes a
`RunSource` that is either `queued` or `transient`; only `queued` does outbox
bookkeeping.

`decodeAudioData` decodes the whole file at its own rate first — 48 kHz stereo
float32 is ~384 KB/s, so an hour of video is ~1.4 GB resident. Hence the
30-minute cap, measured from container metadata. Files under
`MAX_IMPORT_SECONDS × 2 KB/s` (~3.4 MB) skip the probe entirely, since nothing at
a sane speech bitrate can exceed the limit at that size.

### 9. Environment gotchas

- **Git Bash mangles `/`**: `PWA_BASE=/ pnpm build` becomes `C:/Program Files/Git/`.
  Build from PowerShell, or set `MSYS_NO_PATHCONV=1`.
- **`gh` defaults to upstream** in a fork. Run `gh repo set-default iznavibe/vibe`,
  or pass `-R iznavibe/vibe`.
- **pnpm is not on PATH**; use `corepack pnpm`. `corepack enable` needs admin.
- **CI must use Node 24.** The tests import `.ts` directly and rely on type
  stripping, which is only on by default from 23.6.
- **Node ESM needs explicit extensions.** A module imported by a test cannot use
  extensionless relative imports (Vite allows them, Node does not). That is why
  `crash.ts` has no relative imports and `smallerThan` lives in `models.ts`.
- The Claude-in-Chrome extension **blocks fetching audio files** over a few
  hundred KB, which makes browser-based fixture tests fail confusingly. Generate
  WAVs in-page instead.

---

## Current state

Working and deployed — but **not yet confirmed on the actual iPhone** after the
backend fix. That is the immediate next step.

- 48 tests pass; typecheck clean; Pages deploy green.
- Verified in Chrome and via the shipped worker: import, record, decode,
  transcription, segments, crash-report UI, model step-down.
- Verified in Node against a real 47.6 s fixture: 21 coherent segments, absolute
  timestamps, 4.9× realtime on CPU.

### Measured performance — CPU/WASM backend, 8 s of audio, desktop CPU

| model          | inference           | vs realtime   |
| -------------- | ------------------- | ------------- |
| Base           | 2.7 s               | ~3× faster ✅  |
| Small          | 141.9 s             | ~18× slower ❌ |
| Large v3 Turbo | >20 min, abandoned  | unusable ❌    |

Turbo was measured, not assumed (2026-09-17). `q4` encoder + `fp16` decoder,
733 MB, loaded from cache, 10 s of audio: still running after twenty minutes on
a desktop CPU before the run was abandoned.

The hope was that turbo's **4-layer decoder** (vs Small's 12) would make it
cheap, since the decoder runs per token and usually dominates. It does not
help enough: turbo keeps large-v3's full **32-layer, 1280-dim encoder**, and one
encoder pass per 30 s window is what the CPU cannot absorb.

A secondary finding worth keeping: on CPU, **quantised decoders are slower than
`fp32`**, not faster. Base measured `q8/fp32` 6.4 s vs `q8/q4` 15.9 s and
`q8/fp16` 15.4 s — roughly 2.4× — because int4/fp16 matmul has no optimised CPU
kernel here. Quantisation buys download size and costs speed on this backend.

A phone is slower than this. **Base is realistically the only usable model on iOS**
while JSEP is broken. Small is listed with that stated plainly. Turbo has no CPU
variant — offering it would cost ~724 MB to discover it cannot run.

### Download sizes (measured, per backend)

| model          | WebGPU | WASM   |
| -------------- | ------ | ------ |
| Base           | 91 MB  | 140 MB |
| Small          | 318 MB | 310 MB |
| Large v3 Turbo | 537 MB | —      |

---

## How this is actually used (2026-09-17)

The phone is used **outside**, away from the PC, and wants to work offline.

That settles a design question that was open until now: **handoff is not the
product here, on-device is.** Outside means the desktop may be asleep and the
phone is on carrier NAT, which is exactly where iroh struggles — so pairing
optimises for a case that will rarely be available. The engine should be set to
**This phone**, not Automatic, so a run never waits on a desktop that is not
there.

It also means Base's Korean quality is not a fallback question. It is the whole
product.

### Pairing: diagnosed, not fixed

Symptom: "failed to connect to desktop … timed out … transport error".

The desktop is healthy — verified on 2026-09-17:

- `vibe.exe` and `vibe-server.exe` running, `handoff.enabled = true`
- endpoint bound and **persisted** in `%APPDATA%\…\handoff\endpoint.key`,
  so the endpoint ID is stable across restarts
- all three `relay.n0.iroh.link` relays reachable from the PC
- Windows Firewall has inbound allow rules for `vibe.exe`, outbound unrestricted
- `handoff.pairing.devices` is `[]` — **nothing has ever paired**
- the desktop log records **no inbound connection attempt at all**

So the phone never reached the desktop. Not worth chasing further given the
use case above, but if it is ever wanted: try first on the **same Wi-Fi**, which
lets iroh connect directly instead of hole-punching through carrier NAT.

Note the pairing URL's origin has **nothing to do with connectivity** — the
connection is p2p over iroh via n0's public relays, not any upstream server. The
origin only decides which web app opens.

### VIBE_PWA_ORIGIN is set

`setx VIBE_PWA_ORIGIN "https://iznavibe.github.io/vibe"` (user scope), so the
desktop's QR points at this fork rather than upstream. Takes effect for newly
launched processes — Vibe must be fully quit, tray included. Undo with
`setx VIBE_PWA_ORIGIN ""`.

### What actually depends on upstream

Less than it looks:

| Thing | Source |
| --- | --- |
| QR default origin | thewh1teagle.github.io — overridden above |
| Handoff wasm | upstream Pages, **build time only** (`pnpm wasm`) |
| Models | **HuggingFace `onnx-community/*`** — never upstream |
| p2p connection | iroh public relays (n0) — never upstream |

Self-hosting the models on GitHub Pages is **not possible**: Pages enforces a
hard **100 MB per file** limit and Base's decoder alone is 117.9 MB. GitHub
Releases (2 GB/file) would work but buys nothing — HF's CDN is faster and the
file is cached locally after the first fetch.

### Korean-specific models: surveyed, none usable

Searched HF on 2026-09-17 for a Korean fine-tune that would beat generic Base at
Base's speed:

- `onnx-community/whisper-large-v3-turbo-korean-ggml-ONNX` — ONNX exists, but it
  is turbo-sized, so it inherits the CPU speed problem and is unusable here.
- `jiwon65/whisper-small_korean-zeroth`, `TARARARAK/Whisper_base_Korean_finetunning`,
  and the other small/base Korean fine-tunes — **PyTorch only, no ONNX**.

So there is no ready-made fast Korean model. Getting one means exporting a
small/base Korean fine-tune to ONNX (optimum), quantising it to `q8` encoder +
`q4` decoder, and hosting it (HF, not Pages). That is a real project and should
only be started if generic Base proves inadequate on real Korean audio.

## whisper.cpp WASM spike (2026-09-17) — promising, unfinished

Turbo is the model that is actually wanted, so the remaining path was tried:
whisper.cpp compiled to WASM instead of ONNX Runtime. Different runtime, never
touches the JSEP bug, hand-written SIMD kernels that are far better on CPU.

Spiked with `@fugood/whisper.node` (ships browser pthread wasm artifacts),
served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless`, which wasm threads require.

**Established, and encouraging:**

- Cross-origin isolation works; `SharedArrayBuffer` available; `isWasmThreadsSupported()` true.
- The runtime is **4 MB**, against ORT's 13–23 MB.
- `ggml-large-v3-turbo-q5_0.bin` is **547 MB**, comparable to the ONNX turbo's 537 MB.
- That model **loads into the runtime in 1.4 s** from cache. ORT could not create a
  session in twenty minutes.

**Not established — the number that matters:** `transcribe()` fails immediately
with `Error: Failed to fetch`, in the same second it is called. That is a wrapper
integration problem, not a performance verdict, so **turbo's speed under
whisper.cpp remains unmeasured**.

Gotchas found, worth not rediscovering:

- `initWhisper` resolves the model as `options.filePath || options.modelUrl`, so
  the URL must go in `filePath`; passing it as `modelUrl` fetches a relative path
  and 404s.
- Model cache key is the source URL itself, in the cache named by
  `modelCacheName`. Prefetching on the main thread and `cache.put(url, response)`
  makes the package hit its cache — which is how the model got loaded at all,
  since the package's own in-worker fetch stalled indefinitely under COEP.
- `configureWasm` has no `wasmPaths` option (that was invented); the real keys are
  `jsPath`, `wasmPath`, `workerUrl`, `locateFileBaseUrl`. Inspect
  `WASM_CONFIG_PATHS` to see what it resolved. It expects the package's
  `index.js` at its own root path, not renamed.
- `configureWasm` throws if called after the runtime has loaded, so a failed
  attempt poisons the page — reload between tries.

To finish this, either debug the wrapper's transcribe path or build whisper.cpp
to wasm directly with Emscripten and write a minimal binding. Then measure before
building anything on top of it.

Temper expectations even if it works: whisper.cpp turbo on a phone CPU under
wasm with threads is plausibly **2–6x slower than realtime** — a one-minute clip
taking two to six minutes. Far better than ORT's >120x, nowhere near instant.

## The open question

**Is Base good enough for Korean?** Everything else hangs on this. The desktop
runs `ggml-large-v3` (3.0 GB); Base is a different league.

Turbo on-device is settled and the answer is no — see the measurement above. It
is not a configuration that needs finding: WebGPU is unusable on WebKit, and the
CPU cannot run a 32-layer encoder at any tolerable speed. Nothing in this
codebase can change that.

If Base is not good enough, the options are:

1. **Handoff** when the desktop is reachable — already built and working.
2. **whisper.cpp compiled to WASM** instead of ONNX Runtime. Sidesteps JSEP
   entirely (different runtime, never touches ORT) and would put the phone on the
   **same ggml engine as the desktop**, a better architectural fit than the
   current split. CPU-only either way, so the original reason for preferring ORT
   (WebGPU) has evaporated now that WebGPU is unusable on iOS. This is a real
   rebuild of `worker.ts`, not a tweak.
3. **Wait for the WebKit/JSEP bug** to be fixed upstream; Turbo at 537 MB then
   becomes viable and the quality question largely goes away.

Option 2 is the most promising if on-device Korean matters.

## Smaller things not done

- **Diarization.** `segmentation-3.0.onnx` + wespeaker CAM++ are already ONNX, so
  ORT Web could run them — more portable here than to a native port.
- **SRT/VTT export.** Timestamps are absolute, so the data is there.
- **WebCodecs** streaming instead of `decodeAudioData` — the real fix for the
  30-minute import cap.
- **Auto-fallback** from desktop to device when a paired desktop is unreachable.
  Currently `auto` only falls back when there is no peer at all.

---

## Commands

```sh
cd C:\Users\FD\Documents\vibe-phone\handoff\pwa

corepack pnpm install
corepack pnpm wasm      # fetch prebuilt handoff wasm (see below)
corepack pnpm test      # 48 tests
corepack pnpm dev       # http://localhost:8088
```

```powershell
# Production build — PowerShell, not Git Bash (see gotchas)
$env:PWA_BASE="/vibe/"; corepack pnpm build
```

`pnpm wasm` fetches the prebuilt iroh client from upstream's Pages deploy rather
than building `handoff/wasm` from Rust — that needs a pinned wasm-bindgen,
binaryen, and a Linux runner (`ring` compiles C for wasm32 and Apple clang has no
wasm target). Nothing in the on-device path touches that crate. **If you change
the handoff wire protocol you must build it for real** and this shortcut stops
being valid.

Deploys happen automatically on push to `offline-on-device` when anything under
`handoff/pwa/**` changes. The build runs the tests first.

## Testing on the phone

1. Open <https://iznavibe.github.io/vibe/> in Safari.
2. **Share → Add to Home Screen**, then close Safari.
3. Open it from the Home Screen icon, not Safari.
4. Tap **Transcribe on this device**.
5. Settings → remove any old model downloads. Anything cached before `a55b105e`
   is the wrong quantisation and is dead weight.
6. Run **Base**.
7. Then: airplane mode. And a week later, check the model still says "Ready".
