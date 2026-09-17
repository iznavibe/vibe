import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { parsePairingInput } from '../src/lib/pairing.ts'

const endpointId = 'a'.repeat(64)
const token = 'b'.repeat(32)

beforeEach(() => {
	const stored = new Map()
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem: (k) => stored.get(k) ?? null,
			setItem: (k, v) => stored.set(k, v),
			removeItem: (k) => stored.delete(k),
		},
	})
})

test('accepts the whole pairing URL, which is what the QR encodes', () => {
	const peer = parsePairingInput(`https://iznavibe.github.io/vibe/#${endpointId}:${token}`)
	assert.equal(peer?.endpointId, endpointId)
	assert.equal(peer?.token, token)
})

test('accepts a URL from any origin — the fork and upstream both pair the same desktop', () => {
	const peer = parsePairingInput(`https://thewh1teagle.github.io/vibe/phone/#${endpointId}:${token}`)
	assert.equal(peer?.endpointId, endpointId)
})

test('accepts the bare fragment, with or without the hash', () => {
	assert.equal(parsePairingInput(`#${endpointId}:${token}`)?.endpointId, endpointId)
	assert.equal(parsePairingInput(`${endpointId}:${token}`)?.endpointId, endpointId)
})

test('tolerates the whitespace a paste drags in', () => {
	assert.equal(parsePairingInput(`  ${endpointId}:${token}\n`)?.endpointId, endpointId)
})

test('uppercase endpoint IDs are normalised, as in the QR path', () => {
	const peer = parsePairingInput(`${endpointId.toUpperCase()}:${token}`)
	assert.equal(peer?.endpointId, endpointId)
})

test('rejects anything that is not a pairing link', () => {
	assert.equal(parsePairingInput(''), null)
	assert.equal(parsePairingInput('https://example.com'), null)
	assert.equal(parsePairingInput('hello'), null)
	// Right shape, wrong lengths — must not be accepted as a peer.
	assert.equal(parsePairingInput('abc:def'), null)
	assert.equal(parsePairingInput(`${'a'.repeat(63)}:${token}`), null)
})
