/**
 * node-appletv-remote traces its protocol handshake with bare `console.error` calls — around
 * twenty per connection. Companion renders anything a module writes to stderr as an error, so
 * left alone a healthy connect looks like a wall of red. The trace is genuinely useful when a
 * pairing or handshake goes wrong, so it is redirected to the module's debug log rather than
 * discarded, and anything that is not ours is passed straight through.
 */
const LIBRARY_PREFIXES = ['[AirPlay]', '[Companion]', '[MRP]']

type Sink = (message: string) => void

const sinks = new Set<Sink>()
let originalError: typeof console.error | undefined

export function captureLibraryLogging(sink: Sink): () => void {
	sinks.add(sink)

	if (!originalError) {
		originalError = console.error.bind(console)
		const passthrough = originalError

		console.error = (...args: unknown[]): void => {
			const first = args[0]
			if (typeof first === 'string' && LIBRARY_PREFIXES.some((prefix) => first.startsWith(prefix))) {
				const message = args.map((arg) => (typeof arg === 'string' ? arg : safeInspect(arg))).join(' ')
				for (const target of sinks) target(message)
				return
			}

			passthrough(...args)
		}
	}

	return () => {
		sinks.delete(sink)
		if (sinks.size === 0 && originalError) {
			console.error = originalError
			originalError = undefined
		}
	}
}

function safeInspect(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value)
	} catch {
		return String(value)
	}
}
