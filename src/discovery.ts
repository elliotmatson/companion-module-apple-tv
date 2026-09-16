import { Bonjour, type Service } from 'bonjour-service'

/**
 * What mDNS can tell us about one Apple TV.
 *
 * The library ships its own `scan()`, but it only learns a companion-link port for a device it
 * first saw on `_airplay._tcp`, so a missed AirPlay announcement costs the Companion Link port
 * too. Browsing both service types and matching on address keeps them independent.
 *
 * Announcements also just go missing sometimes — measured against real hardware, roughly one
 * query in four came back empty regardless of how the socket was managed. So a lookup makes
 * several short passes instead of one long one and merges whatever each pass saw, which turns
 * a dropped response into a retry rather than a failure.
 */
export interface DiscoveredAppleTv {
	name?: string
	model?: string
	airplayPort?: number
	companionPort?: number
}

export interface DiscoverOptions {
	/** How long each pass listens for */
	passMs?: number
	/** How many passes to make before giving up */
	passes?: number
	/** Keep looking until a companion-link port has been seen, not just a name */
	wantCompanionPort?: boolean
}

/**
 * Listen for the Apple TV at `address` and report what was announced. Never rejects: discovery
 * is best-effort and the caller falls back to whatever it already knows.
 */
export async function discoverAppleTv(address: string, options: DiscoverOptions = {}): Promise<DiscoveredAppleTv> {
	const passes = options.passes ?? 3
	const passMs = options.passMs ?? 2500

	const merged: DiscoveredAppleTv = {}
	for (let pass = 0; pass < passes; pass++) {
		const found = await singlePass(address, passMs, options)

		merged.name ??= found.name
		merged.model ??= found.model
		merged.airplayPort ??= found.airplayPort
		merged.companionPort ??= found.companionPort

		if (isComplete(merged, options)) break
	}

	return merged
}

async function singlePass(address: string, passMs: number, options: DiscoverOptions): Promise<DiscoveredAppleTv> {
	const result: DiscoveredAppleTv = {}

	return new Promise<DiscoveredAppleTv>((resolve) => {
		let instance: Bonjour
		try {
			instance = new Bonjour()
		} catch {
			resolve(result)
			return
		}

		let settled = false
		const finish = () => {
			if (settled) return
			settled = true

			clearTimeout(timer)
			try {
				airplay.stop()
				companion.stop()
				instance.destroy()
			} catch {
				// nothing useful to do if the sockets are already gone
			}
			resolve(result)
		}

		const matches = (service: Service): boolean => (service.addresses ?? []).includes(address)
		const timer = setTimeout(finish, passMs)

		const airplay = instance.find({ type: 'airplay', protocol: 'tcp' }, (service) => {
			if (!matches(service)) return

			const txt = (service.txt ?? {}) as Record<string, string | undefined>
			result.name ??= service.name
			result.model ??= txt.model
			result.airplayPort ??= service.port
			if (isComplete(result, options)) finish()
		})

		const companion = instance.find({ type: 'companion-link', protocol: 'tcp' }, (service) => {
			if (!matches(service)) return

			const txt = (service.txt ?? {}) as Record<string, string | undefined>
			result.companionPort ??= service.port
			result.name ??= service.name
			result.model ??= txt.rpMd
			if (isComplete(result, options)) finish()
		})
	})
}

function isComplete(result: DiscoveredAppleTv, options: DiscoverOptions): boolean {
	if (!result.name) return false
	return !options.wantCompanionPort || result.companionPort !== undefined
}
