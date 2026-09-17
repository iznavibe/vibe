// Minimal service worker. Vite serves `public/` verbatim, so this stays a plain
// classic script with no imports and no build step — which also means nothing
// here is rewritten for the deploy base. Every path is therefore resolved
// against `self.location`, i.e. the directory this worker is served from.
//
// The app is deployed under a subpath (`/vibe/phone/` on GitHub Pages), and a
// worker's default scope is its own directory: a worker at `/vibe/phone/sw.js`
// controls `/vibe/phone/` and below, and nothing of the website around it.
//
// It exists for one reason: make the app installable to the iOS/Android home
// screen and survive a flaky network. It deliberately NEVER cache-firsts the
// handoff wasm, which is rebuilt constantly during development.

const CACHE = 'vibe-phone-v4'

/** Directory this worker was served from — `/` in dev, `/vibe/phone/` in production. */
const BASE = new URL('./', self.location).href

const at = (path) => new URL(path, BASE).href

// Hashed Vite assets are cached on demand; only the entry document is precached.
const SHELL = [
	at('.'),
	at('index.html'),
	at('manifest.webmanifest'),
	at('icons/icon-192.png'),
	at('icons/icon-512.png'),
	at('icons/apple-touch-icon.png'),
	at('logo.svg'),
]

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll(SHELL))
			.catch(() => undefined)
			.then(() => self.skipWaiting()),
	)
})

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	)
})

/**
 * Re-issue a response carrying the headers that make the page isolated.
 *
 * Applied to *every* same-origin response, not only navigations. A dedicated
 * worker spawned from an isolated document inherits that isolation, and its
 * script must be served consistently with it — without these headers on the
 * worker script itself, `new Worker(url, { type: 'module' })` fails with an
 * empty ErrorEvent naming nothing, which reads as a bug inside the worker. It
 * is not: it is the script response missing the policy.
 */
function isolate(res) {
	// A redirected response cannot be reconstructed this way; hand it back as
	// it is rather than throwing on `new Response`.
	if (!res || res.status === 0 || res.type === 'opaqueredirect' || res.redirected) return res
	const headers = new Headers(res.headers)
	headers.set('Cross-Origin-Opener-Policy', 'same-origin')
	headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

self.addEventListener('fetch', (event) => {
	const req = event.request
	if (req.method !== 'GET') return

	const url = new URL(req.url)
	if (url.origin !== self.location.origin) return

	// Always network for the handoff wasm so a rebuild is picked up immediately.
	//
	// Scoped to `/wasm/` — the directory `chore phone-wasm` writes — and NOT to
	// every `.wasm`. The on-device engine's ONNX Runtime ships as a hashed Vite
	// asset under `/assets/`, and it is both immutable and the single largest
	// thing the app needs offline. Matching it here would send 23 MB over the
	// network on every device-mode run, and fail outright in airplane mode,
	// which is the one case on-device transcription exists to serve.
	//
	// Matched by filename, not by directory: whisper.cpp's runtime now shares
	// `/wasm/` and must be cached, or on-device transcription dies offline —
	// the one thing it exists for.
	if (url.pathname.includes('handoff_wasm')) {
		event.respondWith(fetch(req, { cache: 'no-store' }))
		return
	}

	// Navigations: network first, cached shell as the offline fallback. The
	// fallback is this app's own index.html, not the site root's.
	//
	// The document response also gains the cross-origin isolation headers, which
	// is the whole reason this app can use wasm threads. whisper.cpp needs
	// threads (worth ~4x), threads need SharedArrayBuffer, and that needs
	// COOP/COEP on the document — which GitHub Pages will not send and offers no
	// way to configure. A service worker can add them on the way out.
	//
	// `credentialless` rather than `require-corp`: models come cross-origin from
	// Hugging Face, and `require-corp` would demand a CORP header on every one
	// of those responses that we do not control. `credentialless` drops
	// credentials from such requests instead, which is correct for public files
	// and keeps the page isolated.
	if (req.mode === 'navigate') {
		event.respondWith(
			fetch(req)
				.then(isolate)
				.catch(() => caches.match(at('index.html')).then((r) => (r ? isolate(r) : Response.error()))),
		)
		return
	}

	// Everything else (hashed JS/CSS, icons): cache first, refresh in background.
	event.respondWith(
		caches.match(req).then((hit) => {
			const network = fetch(req)
				.then((res) => {
					if (res && res.ok) {
						const copy = res.clone()
						caches
							.open(CACHE)
							.then((c) => c.put(req, copy))
							.catch(() => {})
					}
					return res
				})
				.catch((err) => {
					if (hit) return hit
					throw err
				})
			// Isolation headers go on the served response, never on the cached
			// copy: what is stored stays the plain upstream response, so changing
			// the policy later does not invalidate the whole cache.
			return Promise.resolve(hit || network).then(isolate)
		}),
	)
})
