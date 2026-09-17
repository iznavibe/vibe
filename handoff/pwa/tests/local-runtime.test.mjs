import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOCAL_MODELS, findModel, modelsFor, variantFor } from '../src/lib/local/models.ts'

test('every model declares a runtime', () => {
	for (const m of LOCAL_MODELS) {
		assert.ok(m.runtime === 'onnx' || m.runtime === 'whisper-cpp', `${m.id} has runtime ${m.runtime}`)
	}
})

test('whisper.cpp models carry ggml weights, ONNX models carry a repo', () => {
	for (const m of LOCAL_MODELS) {
		if (m.runtime === 'whisper-cpp') {
			assert.ok(m.ggmlUrl, `${m.id} is whisper-cpp but has no ggmlUrl`)
			assert.match(m.ggmlUrl, /\.bin$/, `${m.id} ggmlUrl should point at a ggml .bin`)
		} else {
			assert.ok(m.repo, `${m.id} is onnx but has no repo`)
		}
	}
})

test('turbo runs on whisper.cpp — ORT could not run it at any usable speed', () => {
	const turbo = findModel('large-v3-turbo')
	assert.equal(turbo?.runtime, 'whisper-cpp')
})

test('turbo is offered on both backends, unlike the ONNX models', () => {
	// whisper.cpp does not use the WebGPU/WASM split, so greying turbo out on
	// one backend would hide it for no reason.
	const turbo = findModel('large-v3-turbo')
	assert.ok(variantFor(turbo, 'wasm'), 'turbo missing a wasm variant')
	assert.ok(variantFor(turbo, 'webgpu'), 'turbo missing a webgpu variant')
})

test('every backend can still run something', () => {
	for (const backend of ['webgpu', 'wasm']) {
		assert.ok(modelsFor(backend).length > 0, `${backend} has no runnable models`)
	}
})

test('the small models stay on ONNX, which is what works on the phone today', () => {
	assert.equal(findModel('base')?.runtime, 'onnx')
	assert.equal(findModel('small')?.runtime, 'onnx')
})
