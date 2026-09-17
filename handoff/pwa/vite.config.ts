import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/**
 * The PWA is deployed inside the Vibe website's GitHub Pages artifact, at
 * `https://thewh1teagle.github.io/vibe/phone/`. Nothing in the app may assume
 * it lives at the domain root: every runtime URL is rebased on
 * `import.meta.env.BASE_URL`, and the manifest/service worker use relative
 * paths so they resolve against wherever they happen to be served from.
 *
 * `PWA_BASE` overrides the production base (must keep the leading and
 * trailing slash). The dev server stays at `/` so `http://localhost:8088/`
 * works unchanged.
 */
const PROD_BASE = process.env.PWA_BASE ?? '/vibe/phone/'

export default defineConfig(({ command }) => ({
	base: command === 'serve' ? '/' : PROD_BASE,
	plugins: [react(), tailwindcss()],
	/*
		Workers must be ES modules, not Vite's default IIFE.

		The whisper.cpp worker loads its runtime with a dynamic `import()` of a
		URL under `public/`, and an IIFE bundle cannot carry that — the worker
		fails at load with an empty `ErrorEvent`, which surfaces as "the engine
		stopped unexpectedly" and says nothing about why.
	*/
	worker: {
		format: 'es',
	},
	resolve: {
		alias: {
			'~': '/src',
		},
	},
	server: {
		port: 8088,
		strictPort: true,
		host: true,
	},
	preview: {
		port: 8088,
		strictPort: true,
		host: true,
	},
}))
