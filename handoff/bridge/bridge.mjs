/**
 * A token gate in front of `vibe-server`, so it can be exposed to the internet.
 *
 * `vibe-server serve` has no authentication of any kind — the only auth strings
 * in the binary belong to its bundled Swagger UI. Put it behind a tunnel as-is
 * and anyone who finds the URL gets unmetered use of the machine's GPU. This
 * sits in front and refuses anything without the right bearer token, so a
 * public tunnel URL is worth nothing on its own.
 *
 * It also answers CORS preflights, which the desktop server has no reason to:
 * the phone app is served from a different origin entirely.
 *
 * Usage:
 *   node bridge.mjs --target http://127.0.0.1:8123 --port 8130
 *
 * The token is read from VIBE_BRIDGE_TOKEN, or generated and printed once on
 * first run and kept in `token.txt` beside this file.
 */
import { createServer, request as httpRequest } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])

const TARGET = new URL(args.get('target') ?? 'http://127.0.0.1:8123')
const PORT = Number(args.get('port') ?? 8130)
const TOKEN_FILE = join(import.meta.dirname, 'token.txt')

function loadToken() {
	const fromEnv = process.env.VIBE_BRIDGE_TOKEN?.trim()
	if (fromEnv) return fromEnv
	if (existsSync(TOKEN_FILE)) {
		const saved = readFileSync(TOKEN_FILE, 'utf8').trim()
		if (saved) return saved
	}
	const generated = randomBytes(24).toString('hex')
	writeFileSync(TOKEN_FILE, generated + '\n', { mode: 0o600 })
	return generated
}

const TOKEN = loadToken()

/**
 * Compare in constant time. The token is the only thing standing between the
 * open internet and someone else's GPU, so a timing oracle on it is not
 * hypothetical.
 */
function tokenMatches(header) {
	const offered = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim()
	if (!offered) return false
	const a = Buffer.from(offered)
	const b = Buffer.from(TOKEN)
	return a.length === b.length && timingSafeEqual(a, b)
}

/** Only what the phone actually needs. Everything else is not reachable. */
const ALLOWED = new Set(['/health', '/v1/models', '/v1/audio/transcriptions'])

function cors(res) {
	// The phone app is served from GitHub Pages, so every request is cross-origin.
	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
	res.setHeader('Access-Control-Max-Age', '86400')
}

function forwardHeaders(headers) {
	const out = { ...headers, host: TARGET.host }
	delete out.authorization
	return out
}

const server = createServer((req, res) => {
	cors(res)

	if (req.method === 'OPTIONS') {
		res.writeHead(204).end()
		return
	}

	const path = (req.url ?? '/').split('?')[0]
	if (!ALLOWED.has(path)) {
		res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }))
		return
	}

	if (!tokenMatches(req.headers.authorization)) {
		// Deliberately terse: a public endpoint should not describe what it wants.
		res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
		return
	}

	const upstream = httpRequest(
		{
			hostname: TARGET.hostname,
			port: TARGET.port,
			path: req.url,
			method: req.method,
			// The bearer token is ours, not the server's; strip it rather than
			// forwarding. Deleted, not set to undefined — Node rejects an
			// undefined header value outright.
			headers: forwardHeaders(req.headers),
		},
		(up) => {
			res.writeHead(up.statusCode ?? 502, up.headers)
			up.pipe(res)
		},
	)

	upstream.on('error', (err) => {
		res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'vibe-server is not reachable', detail: String(err.message) }))
	})

	req.pipe(upstream)
})

server.listen(PORT, '127.0.0.1', () => {
	console.log(`bridge  ->  ${TARGET.origin}`)
	console.log(`listening on http://127.0.0.1:${PORT}`)
	console.log(`token: ${TOKEN}`)
	console.log(`\nPoint cloudflared at http://127.0.0.1:${PORT} and paste the tunnel URL + token into the phone app.`)
})
