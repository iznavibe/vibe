import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { clearCrashReport, markLoadFinished, markLoadStarted, peekCrashedModelId } from '../src/lib/local/crash.ts'
import { LOCAL_MODELS, findModel, smallerThan } from '../src/lib/local/models.ts'

let stored

beforeEach(() => {
	stored = new Map()
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem: (k) => stored.get(k) ?? null,
			setItem: (k, v) => stored.set(k, v),
			removeItem: (k) => stored.delete(k),
		},
	})
})

test('a load that finished leaves nothing to report', () => {
	markLoadStarted('large-v3-turbo')
	markLoadFinished()
	assert.equal(peekCrashedModelId(), null)
})

test('a load that never finished names the model', () => {
	markLoadStarted('large-v3-turbo')
	assert.equal(peekCrashedModelId(), 'large-v3-turbo')
})

test('reading the report does not consume it', () => {
	markLoadStarted('small')
	// React invokes state initializers twice under StrictMode and keeps only
	// one result. A read that cleared would make the report appear or vanish
	// depending on which invocation React kept.
	assert.equal(peekCrashedModelId(), 'small')
	assert.equal(peekCrashedModelId(), 'small')
})

test('clearing it explicitly is what stops it reappearing', () => {
	markLoadStarted('small')
	assert.equal(peekCrashedModelId(), 'small')
	clearCrashReport()
	assert.equal(peekCrashedModelId(), null)
})

test('a stale breadcrumb is ignored', () => {
	stored.set('vibe.local.loadAttempt', JSON.stringify({ modelId: 'small', startedAt: Date.now() - 60 * 60 * 1000 }))
	assert.equal(peekCrashedModelId(), null)
})

test('corrupt or unknown breadcrumbs are ignored, not thrown on', () => {
	stored.set('vibe.local.loadAttempt', 'not json')
	assert.equal(peekCrashedModelId(), null)

	// An id no longer in the list resolves to nothing at the call site.
	stored.set('vibe.local.loadAttempt', JSON.stringify({ modelId: 'gone', startedAt: Date.now() }))
	assert.equal(findModel(peekCrashedModelId() ?? ''), undefined)
})

test('stepping down lands on the next smallest model', () => {
	assert.equal(smallerThan(findModel('large-v3-turbo'))?.id, 'small')
	assert.equal(smallerThan(findModel('small'))?.id, 'base')
})

test('the smallest model suggests nothing — there is nothing smaller to offer', () => {
	assert.equal(smallerThan(LOCAL_MODELS[0]), null)
})

test('models are ordered smallest first, which smallerThan depends on', () => {
	for (let i = 1; i < LOCAL_MODELS.length; i += 1) {
		assert.ok(LOCAL_MODELS[i].approxBytes > LOCAL_MODELS[i - 1].approxBytes, `${LOCAL_MODELS[i].id} is not larger than ${LOCAL_MODELS[i - 1].id}`)
	}
})
