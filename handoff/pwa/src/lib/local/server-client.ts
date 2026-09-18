/**
 * Transcribing on the user's own desktop, reached over an HTTP tunnel.
 *
 * `vibe-server` exposes an OpenAI-shaped `POST /v1/audio/transcriptions`, and
 * a Cloudflare tunnel gives it a public HTTPS address. That machine has a GPU:
 * measured on this one, 47.6 s of audio in 13 s with `large-v3` — roughly nine
 * times faster than the best a phone manages, against a bigger model.
 *
 * It is not offline, which is the trade. The phone sends audio and gets text.
 *
 * Nothing talks to `vibe-server` directly: it has no authentication whatsoever,
 * so `handoff/bridge` sits in front holding a bearer token and answering CORS.
 * The URL configured here is the bridge's, never the server's.
 */

import type { HandoffEvent } from '../handoff'

export const SERVER_URL_KEY = 'vibe.server.url'
export const SERVER_TOKEN_KEY = 'vibe.server.token'
export const SERVER_DISCOVERY_KEY = 'vibe.server.discovery'

export interface ServerConfig {
	/** Resolved address. Overwritten by discovery when that is configured. */
	url: string
	token: string
	/**
	 * Where to look up the current address.
	 *
	 * A quick Cloudflare tunnel gets a new random hostname every time it
	 * starts, so an address typed in by hand goes stale on the next reboot —
	 * and the one place it cannot be looked up from is away from the desktop,
	 * which is the whole point of this feature. The desktop publishes its
	 * current address to a gist instead, and this is the URL that reads it.
	 */
	discovery: string
}

export function loadServerConfig(): ServerConfig {
	try {
		return {
			url: localStorage.getItem(SERVER_URL_KEY) ?? '',
			token: localStorage.getItem(SERVER_TOKEN_KEY) ?? '',
			discovery: localStorage.getItem(SERVER_DISCOVERY_KEY) ?? '',
		}
	} catch {
		return { url: '', token: '', discovery: '' }
	}
}

export function saveServerConfig(config: ServerConfig): void {
	try {
		localStorage.setItem(SERVER_URL_KEY, config.url.trim().replace(/\/+$/, ''))
		localStorage.setItem(SERVER_TOKEN_KEY, config.token.trim())
		localStorage.setItem(SERVER_DISCOVERY_KEY, config.discovery.trim())
	} catch {
		// Only costs the user re-entering it next launch.
	}
}

/** Usable if we know the token and either an address or where to find one. */
export function serverConfigured(config: ServerConfig): boolean {
	return config.token.trim().length > 0 && (config.url.trim().length > 0 || config.discovery.trim().length > 0)
}

/**
 * Ask the gist where the desktop is right now.
 *
 * Read through the GitHub API rather than a `raw.githubusercontent` URL: raw
 * gist content sits behind a CDN that will happily serve the previous address
 * for a while, which is precisely the failure this exists to prevent.
 *
 * A failure here is not fatal — the last known address is still worth trying,
 * since it is usually still correct.
 */
export async function resolveServerUrl(config: ServerConfig, timeoutMs = 10000): Promise<string> {
	const discovery = config.discovery.trim()
	if (!discovery) return config.url

	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), timeoutMs)
	try {
		const res = await fetch(discovery, { cache: 'no-store', signal: abort.signal })
		if (!res.ok) return config.url
		const body = (await res.json()) as { files?: Record<string, { content?: string }> }
		for (const file of Object.values(body.files ?? {})) {
			if (!file.content) continue
			// Strip a byte-order mark before parsing. Windows PowerShell writes one
			// by default, and JSON.parse treats it as a syntax error — which shows
			// up here as "cannot find your desktop" rather than anything readable.
			const parsed = JSON.parse(file.content.replace(/^﻿/, '')) as { url?: string }
			if (parsed.url) return parsed.url.trim().replace(/\/+$/, '')
		}
		return config.url
	} catch {
		return config.url
	} finally {
		clearTimeout(timer)
	}
}

/** Reply shape of `response_format=verbose_json`. */
interface VerboseJson {
	text?: string
	segments?: { start?: number; end?: number; text?: string }[]
}

/**
 * Check the desktop is actually reachable before uploading anything to it.
 *
 * A tunnel that is down, or a token that no longer matches, should cost the
 * user a fast error rather than a long upload that fails at the end.
 */
export async function pingServer(config: ServerConfig, timeoutMs = 8000): Promise<{ ok: true } | { ok: false; message: string }> {
	const url = await resolveServerUrl(config)
	if (!url) return { ok: false, message: 'No address yet. Check the discovery URL, or paste an address directly.' }

	const abort = new AbortController()
	const timer = setTimeout(() => abort.abort(), timeoutMs)
	try {
		const res = await fetch(`${url}/health`, {
			headers: { authorization: `Bearer ${config.token}` },
			signal: abort.signal,
		})
		if (res.status === 401) return { ok: false, message: 'The desktop rejected this token. Check it matches the one the bridge printed.' }
		if (!res.ok) return { ok: false, message: `The desktop answered ${res.status}.` }
		return { ok: true }
	} catch {
		return { ok: false, message: 'Could not reach your desktop. Check it is awake and the tunnel is running.' }
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Upload and transcribe, as the same `HandoffEvent` stream every other engine
 * produces.
 *
 * Uses XMLHttpRequest rather than `fetch` for one reason: upload progress.
 * `fetch` cannot report it, and on a phone uploading a video over cellular
 * that is the only part of the wait the user can see moving.
 */
export function transcribeOnServer(opts: { blob: Blob; filename: string; lang: string | null; config: ServerConfig }): ReadableStream<HandoffEvent> {
	return new ReadableStream<HandoffEvent>({
		start(controller) {
			let settled = false
			const finish = (event: HandoffEvent) => {
				if (settled) return
				settled = true
				controller.enqueue(event)
				controller.close()
			}

			const form = new FormData()
			form.append('file', opts.blob, opts.filename)
			form.append('response_format', 'verbose_json')
			if (opts.lang) form.append('language', opts.lang)

			const startedAt = performance.now()
			const xhr = new XMLHttpRequest()
			xhr.open('POST', `${opts.config.url}/v1/audio/transcriptions`)
			xhr.setRequestHeader('authorization', `Bearer ${opts.config.token}`)

			xhr.upload.onprogress = (e) => {
				if (!e.lengthComputable) return
				controller.enqueue({ type: 'uploadProgress', sent: e.loaded, total: e.total })
			}

			xhr.upload.onload = () => {
				controller.enqueue({ type: 'accepted' })
				// The desktop is now working and will not say anything until it is
				// done, so this is an honest indeterminate wait rather than a bar
				// that pretends to know.
				controller.enqueue({ type: 'status', phase: 'transcribing' })
			}

			xhr.onload = () => {
				if (xhr.status === 401) {
					finish({ type: 'error', code: 'unauthorized', message: 'The desktop rejected this token. Check it in settings.' })
					return
				}
				if (xhr.status < 200 || xhr.status >= 300) {
					finish({ type: 'error', code: `http_${xhr.status}`, message: `The desktop answered ${xhr.status}.` })
					return
				}
				try {
					const body = JSON.parse(xhr.responseText) as VerboseJson
					for (const seg of body.segments ?? []) {
						controller.enqueue({
							type: 'segment',
							start: seg.start ?? 0,
							stop: seg.end ?? seg.start ?? 0,
							text: seg.text ?? '',
							speaker: null,
						})
					}
					finish({
						type: 'done',
						text: (body.text ?? '').trim(),
						processingTimeSec: (performance.now() - startedAt) / 1000,
					})
				} catch {
					finish({ type: 'error', code: 'bad_reply', message: 'The desktop sent a reply this app could not read.' })
				}
			}

			xhr.onerror = () =>
				finish({
					type: 'error',
					code: 'transport',
					message: 'Could not reach your desktop. Check it is awake and the tunnel is running.',
				})
			xhr.ontimeout = () => finish({ type: 'error', code: 'timeout', message: 'The desktop took too long to answer.' })

			// Generous: a long recording on a slow uplink plus the transcription
			// itself. Still bounded, so a dead tunnel does not hang forever.
			xhr.timeout = 30 * 60 * 1000

			xhr.send(form)
		},
	})
}
