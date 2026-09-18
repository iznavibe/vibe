import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { resolveServerUrl, serverConfigured } from '../src/lib/local/server-client.ts'

const GIST = 'https://api.github.com/gists/abc123'

function gistReply(url) {
	return {
		ok: true,
		json: async () => ({ files: { 'vibe-tunnel.json': { content: JSON.stringify({ url, updated: '2026-09-18T00:00:00Z' }) } } }),
	}
}

beforeEach(() => {
	globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
afterEach(() => {
	delete globalThis.fetch
	delete globalThis.localStorage
})

test('a token plus an address is enough', () => {
	assert.equal(serverConfigured({ url: 'https://x.test', token: 't', discovery: '' }), true)
})

test('a token plus discovery is enough — the address is found later', () => {
	assert.equal(serverConfigured({ url: '', token: 't', discovery: GIST }), true)
})

test('a token alone is not enough, and neither is an address alone', () => {
	assert.equal(serverConfigured({ url: '', token: 't', discovery: '' }), false)
	assert.equal(serverConfigured({ url: 'https://x.test', token: '', discovery: '' }), false)
})

test('discovery wins over the remembered address', async () => {
	globalThis.fetch = async () => gistReply('https://fresh.trycloudflare.com')
	const found = await resolveServerUrl({ url: 'https://stale.trycloudflare.com', token: 't', discovery: GIST })
	assert.equal(found, 'https://fresh.trycloudflare.com')
})

test('a trailing slash is trimmed, so paths are not doubled up', async () => {
	globalThis.fetch = async () => gistReply('https://fresh.trycloudflare.com/')
	const found = await resolveServerUrl({ url: '', token: 't', discovery: GIST })
	assert.equal(found, 'https://fresh.trycloudflare.com')
})

test('without discovery the configured address is used unchanged', async () => {
	globalThis.fetch = async () => {
		throw new Error('should not be called')
	}
	const found = await resolveServerUrl({ url: 'https://manual.test', token: 't', discovery: '' })
	assert.equal(found, 'https://manual.test')
})

test('a failed lookup falls back to the last known address rather than nothing', async () => {
	// GitHub being unreachable should not strand a phone whose remembered
	// address is very probably still correct.
	globalThis.fetch = async () => {
		throw new Error('offline')
	}
	const found = await resolveServerUrl({ url: 'https://last-known.test', token: 't', discovery: GIST })
	assert.equal(found, 'https://last-known.test')
})

test('a non-200 from the gist also falls back', async () => {
	globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
	const found = await resolveServerUrl({ url: 'https://last-known.test', token: 't', discovery: GIST })
	assert.equal(found, 'https://last-known.test')
})

test('a gist with unreadable content falls back instead of throwing', async () => {
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ files: { 'x.json': { content: 'not json' } } }) })
	const found = await resolveServerUrl({ url: 'https://last-known.test', token: 't', discovery: GIST })
	assert.equal(found, 'https://last-known.test')
})
