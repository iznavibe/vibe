/**
 * Noticing that the app was killed, and saying so.
 *
 * Loading a model is the one thing this app does that can exhaust a phone's
 * memory. When it does, iOS does not throw an error the page can catch — it
 * kills the web view and reloads it. From the user's side the app spins for a
 * few seconds, vanishes, and comes back to a blank home screen, with nothing
 * anywhere saying what happened or what to do differently. Safari sometimes
 * shows "a problem repeatedly occurred", which is worse than nothing because
 * it sounds like the site is broken.
 *
 * So a breadcrumb is written before the load starts and cleared when it
 * finishes. Finding one at startup means the previous attempt did not survive,
 * and the model it names is almost certainly too big for this device.
 *
 * It cannot distinguish an out-of-memory kill from the user force-quitting
 * mid-load, so the wording suggests rather than asserts.
 */

const KEY = 'vibe.local.loadAttempt'

interface LoadAttempt {
	modelId: string
	startedAt: number
}

/**
 * Attempts older than this are ignored. A breadcrumb can also be left by a
 * tab the user simply closed mid-load, and holding that against them days
 * later would be wrong.
 */
const STALE_AFTER_MS = 10 * 60 * 1000

export function markLoadStarted(modelId: string): void {
	try {
		localStorage.setItem(KEY, JSON.stringify({ modelId, startedAt: Date.now() } satisfies LoadAttempt))
	} catch {
		// Without storage there is no crash report, which costs a better error
		// message and nothing else.
	}
}

/**
 * Discard a pending report once it has been shown, so it does not reappear on
 * the next launch. Same key as a finished load — a report that has been seen
 * and a load that succeeded are equally "nothing to say".
 */
export const clearCrashReport = markLoadFinished

export function markLoadFinished(): void {
	try {
		localStorage.removeItem(KEY)
	} catch {
		// As above.
	}
}

/**
 * The id of the model a previous run died loading, if there was one.
 *
 * Returns an id rather than a `LocalModel` so this module owns no knowledge of
 * the model list — the caller resolves it.
 *
 * Reading does not clear: React invokes state initializers twice under
 * StrictMode and keeps only one result, so a read with a side effect can
 * silently swallow the very report it is meant to surface. Clearing is a
 * separate, explicit `clearCrashReport` the caller runs once it has committed
 * to showing it.
 */
export function peekCrashedModelId(): string | null {
	let raw: string | null = null
	try {
		raw = localStorage.getItem(KEY)
	} catch {
		return null
	}
	if (!raw) return null

	try {
		const parsed = JSON.parse(raw) as Partial<LoadAttempt>
		if (typeof parsed.modelId !== 'string' || typeof parsed.startedAt !== 'number') return null
		if (Date.now() - parsed.startedAt > STALE_AFTER_MS) return null
		return parsed.modelId
	} catch {
		return null
	}
}
