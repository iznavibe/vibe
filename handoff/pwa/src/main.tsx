import React from 'react'
import ReactDOM from 'react-dom/client'
import { Toaster } from 'sonner'

import { App } from '~/App'
import '~/globals.css'

// The desktop app follows the OS theme; a phone PWA has no theme switcher, so
// mirror `prefers-color-scheme` onto the `.dark` class the tokens key off.
function syncTheme() {
	const media = window.matchMedia('(prefers-color-scheme: dark)')
	const apply = () => document.documentElement.classList.toggle('dark', media.matches)
	apply()
	media.addEventListener('change', apply)
}

syncTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<App />
		<Toaster position="top-center" richColors closeButton />
	</React.StrictMode>,
)

/**
 * Reload once, the first time, so the service worker's cross-origin isolation
 * headers apply.
 *
 * A page that registers a worker is not controlled by it, so `crossOriginIsolated`
 * stays false until the next navigation — and without it there is no
 * SharedArrayBuffer and whisper.cpp falls back to its single-threaded build,
 * about four times slower.
 *
 * Guarded by a session flag rather than by the isolation state alone: a browser
 * that ignores the headers entirely would otherwise reload forever. One attempt
 * per session, then the app runs whatever it got.
 */
const RELOAD_FLAG = 'vibe.coi.reloaded'

function reloadOnceForIsolation(_registration: ServiceWorkerRegistration) {
	if (window.crossOriginIsolated) return
	try {
		if (sessionStorage.getItem(RELOAD_FLAG)) return
	} catch {
		// No session storage means no way to guarantee a single attempt, and a
		// reload loop is far worse than a slower engine.
		return
	}

	const reload = () => {
		try {
			sessionStorage.setItem(RELOAD_FLAG, '1')
		} catch {
			return
		}
		window.location.reload()
	}

	/*
		Wait for the worker to be *controlling*, not merely active.

		A reload issued before `controller` is set produces another uncontrolled
		document, which is no more isolated than the first — and the one-shot
		guard would then block the reload that would actually have worked. So the
		trigger is `controllerchange`, with the already-controlled case handled
		directly for a returning visitor.
	*/
	if (navigator.serviceWorker.controller) {
		reload()
		return
	}
	navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true })
}

if ('serviceWorker' in navigator) {
	window.addEventListener('load', () => {
		// Registered at the deploy base, not the root. A worker at
		// `/vibe/phone/sw.js` gets scope `/vibe/phone/` — exactly the app's
		// subtree, and nothing of the website around it.
		const base = import.meta.env.BASE_URL
		navigator.serviceWorker
			.register(`${base}sw.js`, { scope: base })
			.then(reloadOnceForIsolation)
			.catch(() => {
				/* installability is a nice-to-have, never fatal */
			})
	})
}
