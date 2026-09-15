import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { isWebKit, pickBackend } from '../src/lib/local/backend.ts'

/**
 * Getting this wrong is expensive in both directions: a false negative sends
 * Safari down the JSEP path that kills the content process, and a false
 * positive drops Chrome to CPU-only for no reason.
 */
function fakeBrowser({ gesture = false, ua = '', gpu = true } = {}) {
	const win = {}
	if (gesture) win.GestureEvent = function GestureEvent() {}
	Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { userAgent: ua, ...(gpu ? { gpu: { requestAdapter: async () => ({}) } } : {}) },
	})
}

afterEach(() => {
	delete globalThis.window
	delete globalThis.navigator
})

const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1'
const CHROME_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'

test('GestureEvent identifies WebKit whatever the browser is branded', () => {
	// Chrome on iOS is WebKit underneath and crashes the same way, so branding
	// must not be what decides this.
	fakeBrowser({ gesture: true, ua: IPHONE_CHROME })
	assert.equal(isWebKit(), true)
})

test('Safari is WebKit', () => {
	fakeBrowser({ ua: SAFARI_MAC })
	assert.equal(isWebKit(), true)
	fakeBrowser({ ua: IPHONE_SAFARI })
	assert.equal(isWebKit(), true)
})

test('Chrome is not WebKit, despite saying "Safari" in its user agent', () => {
	fakeBrowser({ ua: CHROME_DESKTOP })
	assert.equal(isWebKit(), false)
	fakeBrowser({ ua: ANDROID_CHROME })
	assert.equal(isWebKit(), false)
})

test('WebKit never gets WebGPU, even with an adapter available', async () => {
	// The adapter exists on iOS 26. Using it is what kills the process.
	fakeBrowser({ gesture: true, ua: IPHONE_SAFARI, gpu: true })
	assert.equal(await pickBackend(), 'wasm')
})

test('a non-WebKit browser with an adapter gets WebGPU', async () => {
	fakeBrowser({ ua: CHROME_DESKTOP, gpu: true })
	assert.equal(await pickBackend(), 'webgpu')
})

test('a browser with no adapter falls back to wasm rather than failing', async () => {
	fakeBrowser({ ua: CHROME_DESKTOP, gpu: false })
	assert.equal(await pickBackend(), 'wasm')
})
