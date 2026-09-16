import {
	AppleTV,
	Credentials,
	Key,
	PlaybackState,
	type HAPCredentials,
	type NowPlayingInfo,
	type OpackDict,
	type OpackValue,
} from 'node-appletv-remote'
import { createHash } from 'node:crypto'
import type { RemoteKeyId } from './actions.js'
import { discoverAppleTv } from './discovery.js'

export interface AppEntry {
	bundleId: string
	name: string
}

export { Key, PlaybackState }

export type Transport = 'airplay' | 'companion' | 'both'

/** An unreachable host would otherwise sit in the OS TCP timeout for well over a minute. */
const CONNECT_TIMEOUT_MS = 20000
const PAIR_TIMEOUT_MS = 15000
const RECONNECT_DELAY_MS = 10000
/** Companion Link message types, from pyatv's protocol description. */
const COMPANION_EVENT = 1
const COMPANION_REQUEST = 2
/** The Apple TV closes a Companion Link connection it considers idle after about 30 seconds. */
const COMPANION_KEEPALIVE_MS = 20000

export type PowerState = 'on' | 'off' | 'unknown'

/** SystemStatus values, from pyatv. Anything else is left as unknown. */
const SYSTEM_STATUS_POWER: Record<number, PowerState | undefined> = {
	1: 'off', // Asleep
	2: 'on', // Screensaver
	3: 'on', // Awake
	4: 'on', // Idle
}
/** The data channel needs a moment after it opens before the Apple TV answers queries. */
const INITIAL_STATE_DELAY_MS = 1500

/**
 * HID usage codes accepted by the Companion Link `_hidC` command, as documented by pyatv.
 * Only the keys Companion Link can express are listed; the rest need the AirPlay transport.
 */
const COMPANION_HID_CODES: Partial<Record<RemoteKeyId, number>> = {
	up: 1,
	down: 2,
	left: 3,
	right: 4,
	menu: 5,
	select: 6,
	home: 7,
	home_hold: 7,
	volume_up: 8,
	volume_down: 9,
	suspend: 12,
	wake: 13,
	play_pause: 14,
}

export interface DeviceTarget {
	host: string
	port: number
	transport: Transport
}

export interface DeviceState {
	connected: boolean
	companionConnected: boolean
	name: string
	model: string
	host: string

	playbackState: PlaybackState
	title: string
	artist: string
	album: string
	appName: string
	appBundleId: string
	powerState: PowerState

	duration: number
	/** Elapsed position at the moment `elapsedAt` was captured */
	elapsedBase: number
	elapsedAt: number
	playbackRate: number
}

export interface DeviceHost {
	log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
	onConnectionChanged(): void
	onStateChanged(): void
	onAppsChanged(): void
}

const emptyMedia = {
	playbackState: PlaybackState.Unknown,
	title: '',
	artist: '',
	album: '',
	appName: '',
	appBundleId: '',
	duration: 0,
	elapsedBase: 0,
	elapsedAt: 0,
	playbackRate: 0,
}

/** The pairing flow is two steps, so the in-progress session has to live somewhere between saves. */
interface PendingPairing {
	protocol: 'airplay' | 'companion'
	finish: (pin: string) => Promise<HAPCredentials>
	destroy: () => void
}

interface DiscoveredInfo {
	name: string
	address: string
	port: number
	deviceId: string
	model: string
	companionPort?: number
}

/**
 * Owns the connection to a single Apple TV. AirPlay and Companion Link are connected,
 * retried and reported independently, so losing one does not disturb the other.
 */
export class AppleTvDevice {
	readonly #host: DeviceHost

	#atv: AppleTV | undefined
	#target: DeviceTarget | undefined
	#credentials: Credentials | undefined

	#airplayTimer: NodeJS.Timeout | undefined
	#companionTimer: NodeJS.Timeout | undefined
	#seedTimer: NodeJS.Timeout | undefined
	#keepaliveTimer: NodeJS.Timeout | undefined
	#airplayConnecting = false
	#companionConnecting = false
	#destroyed = true
	#stateRequestFailed = false

	#pending: PendingPairing | undefined

	/** Port announced by the Apple TV; re-read whenever it is still unknown. */
	#companionPort: number | undefined
	#companionPortWarned = false

	/** Launchable apps reported by the Apple TV, used for the "Launch app" choices. */
	apps: AppEntry[] = []

	state: DeviceState = {
		connected: false,
		companionConnected: false,
		name: '',
		model: '',
		host: '',
		powerState: 'unknown',
		...emptyMedia,
	}

	constructor(host: DeviceHost) {
		this.#host = host
	}

	get isConnected(): boolean {
		return this.state.connected
	}

	get isCompanionConnected(): boolean {
		return this.state.companionConnected
	}

	/** True when at least one transport is up, which is all most actions need. */
	get isOnline(): boolean {
		return this.state.connected || this.state.companionConnected
	}

	get isAirplayConnecting(): boolean {
		return this.#airplayConnecting
	}

	get isCompanionConnecting(): boolean {
		return this.#companionConnecting
	}

	get hasPendingPairing(): boolean {
		return this.#pending !== undefined
	}

	/** Which protocol is waiting on a PIN, so the status can say which one to type. */
	get pendingPairingProtocol(): 'airplay' | 'companion' | undefined {
		return this.#pending?.protocol
	}

	get wantsAirplay(): boolean {
		return this.#target !== undefined && this.#target.transport !== 'companion'
	}

	get wantsCompanion(): boolean {
		if (!this.#target || this.#target.transport === 'airplay') return false
		return this.#credentials?.companionCredentials !== undefined
	}

	/** Position in seconds, extrapolated from the last update using the playback rate. */
	get elapsed(): number {
		const { elapsedBase, elapsedAt, playbackRate, duration } = this.state
		if (elapsedAt === 0) return 0

		const drift = playbackRate !== 0 ? ((Date.now() - elapsedAt) / 1000) * playbackRate : 0
		const value = elapsedBase + drift
		if (duration > 0 && value > duration) return duration
		return value > 0 ? value : 0
	}

	// --- Lifecycle -------------------------------------------------------------

	/**
	 * Connecting can take a while, so it runs in the background and reports through the host
	 * callbacks. Blocking here would stall the module's `init`/`configUpdated`.
	 */
	async start(target: DeviceTarget, credentials: Credentials | undefined): Promise<void> {
		await this.stop()

		this.#destroyed = false
		this.#target = target
		this.#credentials = credentials
		this.state.host = target.host

		void this.#openConnections()
	}

	async stop(): Promise<void> {
		this.#destroyed = true
		this.#companionPort = undefined
		this.#companionPortWarned = false
		this.state.powerState = 'unknown'
		this.#clearTimers()
		this.#cancelPairing()

		const atv = this.#atv
		this.#atv = undefined
		if (atv) {
			atv.removeAllListeners()
			try {
				await atv.close()
			} catch (e) {
				this.#host.log('debug', `Error closing connection: ${errorMessage(e)}`)
			}
		}

		this.#setConnected(false, false)
	}

	async #openConnections(): Promise<void> {
		const target = this.#target
		const credentials = this.#credentials
		if (!target || !credentials || this.#destroyed) return

		try {
			this.#host.log('info', `Connecting to ${target.host}`)
			const info = await this.#discover(target)
			if (this.#destroyed) return

			const atv = new AppleTV(info)
			this.#atv = atv
			this.#attachListeners(atv)

			this.state.name = info.name
			this.state.model = info.model

			// Bonjour lists every AirPlay receiver, including Macs and third-party TVs, which
			// accept the connection but ignore most remote commands.
			if (info.model && !info.model.startsWith('AppleTV')) {
				this.#host.log('warn', `${info.model} is an AirPlay receiver but not an Apple TV; commands may be ignored`)
			}
		} catch (e) {
			this.#host.log('error', `Could not prepare the connection: ${errorMessage(e)}`)
			this.#scheduleAirplayRetry()
			return
		}

		// Each transport stands on its own — one failing must not block the other.
		await Promise.all([this.connectAirplay(), this.connectCompanion()])
	}

	async connectAirplay(): Promise<void> {
		const atv = this.#atv
		const target = this.#target
		const credentials = this.#credentials
		if (!atv || !target || !credentials || this.#destroyed) return
		if (!this.wantsAirplay || this.state.connected || this.#airplayConnecting) return

		this.#airplayConnecting = true
		if (this.#airplayTimer) clearTimeout(this.#airplayTimer)
		this.#airplayTimer = undefined

		try {
			try {
				await withTimeout(atv.connect(credentials), CONNECT_TIMEOUT_MS, `connect to ${target.host}`)
			} catch (e) {
				// An abandoned socket would keep the OS TCP timeout running in the background.
				await atv.close().catch(() => undefined)
				throw e
			}

			this.#setConnected(true, this.state.companionConnected)
			this.#host.log('info', `AirPlay connected to ${this.state.name || target.host}`)

			// The Apple TV pushes every later change by itself (the library subscribes with
			// ClientUpdatesConfig during MRP setup), but it says nothing about what is already
			// playing, so ask once to seed the state.
			this.#seedTimer = setTimeout(() => {
				this.#seedTimer = undefined
				void this.refreshState()
			}, INITIAL_STATE_DELAY_MS)
		} catch (e) {
			this.#host.log('error', `AirPlay connection failed: ${errorMessage(e)}`)
			this.#setConnected(false, this.state.companionConnected)
			this.#scheduleAirplayRetry()
		} finally {
			this.#airplayConnecting = false
		}
	}

	async connectCompanion(): Promise<void> {
		const atv = this.#atv
		const target = this.#target
		if (!atv || !target || this.#destroyed) return
		if (target.transport === 'airplay') return
		if (this.state.companionConnected || this.#companionConnecting) return

		const companionCreds = this.#credentials?.companionCredentials
		if (!companionCreds) {
			// 'both' is the default, so a missing Companion Link pairing is normal, not an error.
			const message = 'Companion Link has not been paired yet'
			if (target.transport === 'companion') this.#host.log('error', message)
			else this.#host.log('debug', message)
			return
		}

		let port = this.#companionPort
		if (!port) {
			// The port is announced over mDNS and nowhere else, so a missed announcement has to
			// be retried rather than waited on.
			const found = await discoverAppleTv(target.host, { wantCompanionPort: true })
			if (found.companionPort) this.#companionPort = found.companionPort
			if (found.name) this.state.name = found.name
			port = this.#companionPort
		}

		if (!port) {
			// Repeating this every retry buries the rest of the log.
			this.#host.log(
				this.#companionPortWarned ? 'debug' : 'warn',
				'Could not find the Companion Link port over Bonjour; will keep looking',
			)
			this.#companionPortWarned = true
			this.#scheduleCompanionRetry()
			return
		}

		this.#companionPortWarned = false

		this.#companionConnecting = true
		if (this.#companionTimer) clearTimeout(this.#companionTimer)
		this.#companionTimer = undefined

		try {
			await withTimeout(
				atv.connectCompanion(companionCreds, port),
				CONNECT_TIMEOUT_MS,
				`connect to Companion Link on ${target.host}:${port}`,
			)

			this.#setConnected(this.state.connected, true)
			this.#host.log('info', 'Companion Link connected')

			await this.#startCompanionSession()
		} catch (e) {
			this.#host.log('warn', `Companion Link connection failed: ${errorMessage(e)}`)
			this.#setConnected(this.state.connected, false)
			this.#scheduleCompanionRetry()
		} finally {
			this.#companionConnecting = false
		}
	}

	/**
	 * pyatv's CompanionAPI.connect() runs six steps before it considers the connection usable:
	 * introduce ourselves, open a touch session, open a remote session, open a text session,
	 * and register interest in events. Each is best-effort here — the ones we depend on are
	 * the session and the app list — but a device that never hears the rest appears to treat
	 * the connection as uninteresting and closes it after about half a minute.
	 */
	async #startCompanionSession(): Promise<void> {
		const clientId = this.#credentials?.companionCredentials?.clientId ?? 'companion'
		// pyatv sends a MAC-shaped device id; derive a stable one rather than inventing a new
		// identity on every connect.
		const digest = createHash('sha256').update(clientId).digest('hex').slice(0, 12)
		const macShaped = (digest.match(/../g) ?? []).join(':').toUpperCase()

		await this.#companionStep('_systemInfo', 'introduce ourselves', [
			['_bf', 0],
			['_cf', 512],
			['_clFl', 128],
			// A null identifier here stops the Apple TV pushing power state events.
			['_i', digest],
			['_idsID', clientId],
			['_pubID', macShaped],
			['_sf', 256],
			['_sv', '170.18'],
			['model', 'Companion'],
			['name', 'Bitfocus Companion'],
		])

		await this.#companionStep('_touchStart', 'open a touch session', [
			['_height', 1000],
			['_tFl', 0],
			['_width', 1000],
		])

		const localSid = Math.floor(Math.random() * 0xffffffff)
		const session = await this.#companionStep('_sessionStart', 'start a session', [
			['_srvT', 'com.apple.tvremoteservices'],
			['_sid', localSid],
		])
		if (session) {
			this.#host.log('debug', `Companion Link session started (remote sid ${asNumber(session.get('_sid')) ?? '?'})`)
		}

		await this.#companionStep('TVRCSessionStart', 'open a remote session', [['ProtocolVersionKey', '1.2']])
		await this.#companionStep('_tiStart', 'open a text input session', [])

		// Sent as an event rather than a request: nothing answers it, and registering interest
		// is what stops the Apple TV treating us as an idle client.
		try {
			const interest: OpackDict = new Map<OpackValue, OpackValue>([
				['_regEvents', ['_iMC', 'SystemStatus', 'TVSystemStatus']],
			])
			this.companionEvent('_interest', interest)
		} catch (e) {
			this.#host.log('debug', `Companion Link interest registration failed: ${errorMessage(e)}`)
		}

		// Also the initial power state. pyatv notes newer tvOS may answer "No request handler",
		// so a failure here is expected rather than a problem.
		const attention = await this.#companionStep('FetchAttentionState', 'read the power state', [])
		this.#applySystemStatus(attention?.get('state'))

		await this.#fetchAppList()
		this.#startKeepalive()
	}

	/**
	 * Something has to cross the Companion Link connection every so often or the Apple TV drops
	 * it. Re-reading the power state doubles as the traffic, and any answer at all -- including
	 * a refusal -- proves the connection is alive.
	 */
	#startKeepalive(): void {
		this.#stopKeepalive()

		this.#keepaliveTimer = setInterval(() => {
			void (async () => {
				try {
					const response = await this.companionRequest('FetchAttentionState', new Map())
					this.#applySystemStatus(response.get('state'))
				} catch (e) {
					this.#host.log('debug', `Companion Link keepalive got no answer: ${errorMessage(e)}`)
				}
			})()
		}, COMPANION_KEEPALIVE_MS)
	}

	#stopKeepalive(): void {
		if (this.#keepaliveTimer) clearInterval(this.#keepaliveTimer)
		this.#keepaliveTimer = undefined
	}

	/** SystemStatus arrives both as an answer to FetchAttentionState and as a pushed event. */
	#applySystemStatus(value: OpackValue | undefined): void {
		const status = asNumber(value)
		if (status === undefined) return

		const powerState = SYSTEM_STATUS_POWER[status] ?? 'unknown'
		if (powerState === this.state.powerState) return

		this.state.powerState = powerState
		this.#host.log('debug', `Apple TV reports it is ${powerState === 'off' ? 'asleep' : powerState}`)
		this.#host.onStateChanged()
	}

	/** One best-effort step of the handshake; a failure is logged and never fatal. */
	async #companionStep(
		identifier: string,
		what: string,
		entries: [OpackValue, OpackValue][],
	): Promise<OpackDict | undefined> {
		try {
			return await this.companionRequest(identifier, new Map<OpackValue, OpackValue>(entries))
		} catch (e) {
			this.#host.log('debug', `Companion Link could not ${what} (${identifier}): ${errorMessage(e)}`)
			return undefined
		}
	}

	/** The launchable app list doubles as the choices for the "Launch app" action. */
	async #fetchAppList(): Promise<void> {
		try {
			const response = await this.companionRequest('FetchLaunchableApplicationsEvent', new Map())

			const apps: AppEntry[] = []
			for (const [bundleId, name] of response) {
				if (typeof bundleId === 'string' && typeof name === 'string') apps.push({ bundleId, name })
			}
			apps.sort((a, b) => a.name.localeCompare(b.name))

			// Republishing the actions rebuilds every dropdown in the UI, so only do it when
			// the list actually differs -- otherwise a reconnect loop churns the whole editor.
			const unchanged =
				apps.length === this.apps.length &&
				apps.every((app, i) => app.bundleId === this.apps[i].bundleId && app.name === this.apps[i].name)

			this.apps = apps
			if (unchanged) {
				this.#host.log('debug', `Found ${apps.length} launchable apps (unchanged)`)
				return
			}

			this.#host.log('info', `Found ${apps.length} launchable app${apps.length === 1 ? '' : 's'}`)
			this.#host.onAppsChanged()
		} catch (e) {
			this.#host.log('debug', `Could not fetch the app list: ${errorMessage(e)}`)
		}
	}

	async #discover(target: DeviceTarget): Promise<DiscoveredInfo> {
		const wantCompanionPort = target.transport !== 'airplay'

		this.#host.log('debug', 'Looking the Apple TV up over Bonjour')
		const found = await discoverAppleTv(target.host, { wantCompanionPort })

		if (found.name) this.state.name = found.name
		if (found.model) this.state.model = found.model
		if (found.companionPort) this.#companionPort = found.companionPort

		if (!found.name && !found.companionPort) {
			this.#host.log('debug', `Bonjour did not answer for ${target.host}; using what we already know`)
		}

		return {
			name: this.state.name,
			address: target.host,
			port: target.port || found.airplayPort || 7000,
			deviceId: '',
			model: this.state.model,
			companionPort: this.#companionPort,
		}
	}

	#attachListeners(atv: AppleTV): void {
		atv.on('error', (err: Error) => {
			this.#host.log('error', `Apple TV error: ${errorMessage(err)}`)
		})
		atv.on('close', () => {
			if (this.#atv !== atv || !this.state.connected) return
			this.#host.log('info', 'AirPlay connection closed')
			this.#setConnected(false, this.state.companionConnected)
			this.#scheduleAirplayRetry()
		})
		atv.on('companionClose', () => {
			if (this.#atv !== atv || !this.state.companionConnected) return
			this.#host.log('info', 'Companion Link connection closed')
			this.#stopKeepalive()
			this.#setConnected(this.state.connected, false)
			this.#scheduleCompanionRetry()
		})
		atv.on('companionEvent', (event: { identifier: string | undefined; data: OpackDict }) => {
			this.#host.log('debug', `Companion Link event: ${event.identifier ?? '(no identifier)'}`)

			if (event.identifier === 'SystemStatus' || event.identifier === 'TVSystemStatus') {
				const content = event.data.get('_c')
				if (content instanceof Map) this.#applySystemStatus(content.get('state'))
			}
		})
		atv.on('companionError', (err: Error) => {
			this.#host.log('warn', `Companion Link error: ${errorMessage(err)}`)
		})
		atv.on('nowPlaying', (info: NowPlayingInfo) => {
			this.#applyNowPlaying(info)
		})
		atv.on('message', (msg: { type: number; payload: Record<string, unknown> }) => {
			this.#applyRawMessage(msg)
		})
	}

	#scheduleAirplayRetry(): void {
		if (this.#destroyed || this.#airplayTimer || !this.wantsAirplay) return

		this.#airplayTimer = setTimeout(() => {
			this.#airplayTimer = undefined
			void this.connectAirplay()
		}, RECONNECT_DELAY_MS)
	}

	#scheduleCompanionRetry(): void {
		if (this.#destroyed || this.#companionTimer || !this.wantsCompanion) return

		this.#companionTimer = setTimeout(() => {
			this.#companionTimer = undefined
			void this.connectCompanion()
		}, RECONNECT_DELAY_MS)
	}

	#clearTimers(): void {
		if (this.#airplayTimer) clearTimeout(this.#airplayTimer)
		if (this.#companionTimer) clearTimeout(this.#companionTimer)
		if (this.#seedTimer) clearTimeout(this.#seedTimer)
		this.#airplayTimer = undefined
		this.#companionTimer = undefined
		this.#seedTimer = undefined
		this.#stopKeepalive()
	}

	#setConnected(connected: boolean, companionConnected: boolean): void {
		const changed = this.state.connected !== connected || this.state.companionConnected !== companionConnected
		this.state.connected = connected
		this.state.companionConnected = companionConnected

		if (!connected) Object.assign(this.state, emptyMedia)
		// The app list is kept across a drop: it rarely changes, and clearing it would empty
		// the "Launch app" dropdown every time the connection blips.
		if (changed) this.#host.onConnectionChanged()
	}

	// --- State -----------------------------------------------------------------

	/** Ask the Apple TV for the current now-playing item. */
	async refreshState(): Promise<void> {
		const atv = this.#atv
		if (!atv || !this.state.connected) return

		try {
			const response = await atv.getState()
			this.#stateRequestFailed = false
			this.#applyRawMessage({ type: 4, payload: response })
		} catch (e) {
			// An idle Apple TV simply never answers, so only mention it when the status changes.
			if (!this.#stateRequestFailed) {
				this.#stateRequestFailed = true
				this.#host.log('debug', `State request got no answer (nothing playing?): ${errorMessage(e)}`)
			}
		}
	}

	#applyNowPlaying(info: NowPlayingInfo): void {
		this.state.playbackState = info.playbackState
		this.state.title = info.title
		this.state.artist = info.artist
		this.state.album = info.album
		this.state.duration = info.duration
		this.state.elapsedBase = info.elapsedTime
		this.state.elapsedAt = Date.now()
		this.state.playbackRate = info.playbackRate
		if (info.appDisplayName) this.state.appName = info.appDisplayName

		this.#host.onStateChanged()
	}

	/**
	 * SetState messages carry more than the `nowPlaying` event exposes — notably the metadata
	 * returned by a playback queue request. The foreground app is reported separately as well,
	 * by messages that arrive whether or not anything is playing.
	 */
	#applyRawMessage(msg: { type: number; payload: Record<string, unknown> }): void {
		let changed = this.#applyClient(msg.payload)

		if (msg.type !== 4) {
			if (changed) this.#host.onStateChanged()
			return
		}

		const setState = asRecord(msg.payload['.setStateMessage'])
		if (!setState) {
			if (changed) this.#host.onStateChanged()
			return
		}

		const displayName = asString(setState.displayName)
		if (displayName && displayName !== this.state.appName) {
			this.state.appName = displayName
			changed = true
		}

		const reportedState = asPlaybackState(setState.playbackState)
		if (reportedState !== undefined && reportedState !== this.state.playbackState) {
			this.state.playbackState = reportedState
			changed = true
		}

		const items = asRecord(setState.playbackQueue)?.contentItems
		const metadata = Array.isArray(items) ? asRecord(asRecord(items[0])?.metadata) : undefined
		if (metadata) {
			this.state.title = asString(metadata.title) ?? ''
			this.state.artist = asString(metadata.trackArtistName) ?? asString(metadata.albumArtistName) ?? ''
			this.state.album = asString(metadata.albumName) ?? ''
			this.state.duration = asNumber(metadata.duration) ?? 0
			this.state.elapsedBase = asNumber(metadata.elapsedTime) ?? 0
			this.state.elapsedAt = Date.now()
			this.state.playbackRate = asNumber(metadata.playbackRate) ?? 0

			// A queue response has no playbackState field, so derive it from the rate.
			if (reportedState === undefined) {
				this.state.playbackState = this.state.playbackRate > 0 ? PlaybackState.Playing : PlaybackState.Paused
			}
			changed = true
		}

		if (changed) this.#host.onStateChanged()
	}

	/**
	 * The app on screen is announced by SetNowPlayingClient and UpdateClient as well as riding
	 * along on a SetState, so reading only the latter leaves the app unknown until something
	 * actually plays.
	 */
	#applyClient(payload: Record<string, unknown>): boolean {
		const client =
			asRecord(asRecord(payload['.setNowPlayingClientMessage'])?.client) ??
			asRecord(asRecord(payload['.updateClientMessage'])?.client) ??
			asRecord(asRecord(asRecord(payload['.setStateMessage'])?.playerPath)?.client)
		if (!client) return false

		let changed = false

		const bundleId = asString(client.bundleIdentifier)
		if (bundleId && bundleId !== this.state.appBundleId) {
			this.state.appBundleId = bundleId
			changed = true
		}

		// Some apps announce a bundle id with no friendly name; the list from Companion Link
		// usually has one, so fall back to that before leaving it blank.
		const displayName = asString(client.displayName) ?? this.appNameFor(bundleId)
		if (displayName && displayName !== this.state.appName) {
			this.state.appName = displayName
			changed = true
		}

		return changed
	}

	/** Friendly name for a bundle id, if Companion Link told us about it. */
	appNameFor(bundleId: string | undefined): string | undefined {
		if (!bundleId) return undefined
		return this.apps.find((app) => app.bundleId === bundleId)?.name
	}

	// --- Commands --------------------------------------------------------------

	#requireAirplay(what: string): AppleTV {
		const atv = this.#atv
		if (!atv || !this.state.connected) {
			throw new Error(
				this.state.companionConnected
					? `${what} needs the AirPlay connection, which is not available`
					: 'Not connected to the Apple TV',
			)
		}
		return atv
	}

	/** Prefers AirPlay, falling back to the Companion Link HID commands when it is the only link. */
	async sendKey(key: RemoteKeyId): Promise<void> {
		const atv = this.#atv

		if (atv && this.state.connected) {
			if (key === 'stop') await atv.stop()
			else await atv.sendKeyCommand(key as Key)
			return
		}

		if (atv && this.state.companionConnected) {
			await this.#sendCompanionKey(key)
			return
		}

		throw new Error('Not connected to the Apple TV')
	}

	async #sendCompanionKey(key: RemoteKeyId): Promise<void> {
		const code = COMPANION_HID_CODES[key]
		if (code === undefined) {
			throw new Error(`"${key}" can only be sent over the AirPlay connection`)
		}

		const press = async (buttonState: number): Promise<void> => {
			const content: OpackDict = new Map()
			content.set('_hBtS', buttonState)
			content.set('_hidC', code)
			await this.companionRequest('_hidC', content)
		}

		await press(1)
		if (key === 'home_hold') await delay(1000)
		await press(2)
	}

	async sendText(text: string, mode: 'set' | 'insert'): Promise<void> {
		const atv = this.#requireAirplay('The on-screen keyboard')
		if (mode === 'set') await atv.setText(text)
		else await atv.insertText(text)
	}

	async clearText(): Promise<void> {
		await this.#requireAirplay('The on-screen keyboard').clearText()
	}

	async deleteText(): Promise<void> {
		await this.#requireAirplay('The on-screen keyboard').deleteText()
	}

	/**
	 * Companion Link commands travel in an envelope: the identifier and transfer id sit at the
	 * top level next to a message type, and the actual arguments are nested under `_c`. The
	 * library adds `_i` and `_x` for us, so we supply the rest and unwrap the reply's `_c`.
	 */
	async companionRequest(identifier: string, content: OpackDict): Promise<OpackDict> {
		const atv = this.#atv
		if (!atv || !this.state.companionConnected) throw new Error('Companion Link is not connected')

		const envelope: OpackDict = new Map<OpackValue, OpackValue>([
			['_t', COMPANION_REQUEST],
			['_c', content],
		])

		const response = await atv.sendCompanionRequest(identifier, envelope)
		const body = response.get('_c')
		return body instanceof Map ? body : new Map()
	}

	/** Fire-and-forget counterpart to companionRequest, for messages nothing answers. */
	companionEvent(identifier: string, content: OpackDict): void {
		const atv = this.#atv
		if (!atv || !this.state.companionConnected) throw new Error('Companion Link is not connected')

		const envelope: OpackDict = new Map<OpackValue, OpackValue>([
			['_t', COMPANION_EVENT],
			['_c', content],
			['_x', Math.floor(Math.random() * 0xffff)],
		])
		atv.sendCompanionMessage(identifier, envelope)
	}

	async launchApp(bundleIdOrUrl: string): Promise<void> {
		// A URL or a custom scheme goes in a different field to a bundle identifier.
		const key = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(bundleIdOrUrl) ? '_urlS' : '_bundleID'

		const content: OpackDict = new Map<OpackValue, OpackValue>([[key, bundleIdOrUrl]])
		await this.companionRequest('_launchApp', content)
	}

	/** Re-read the launchable app list, if Companion Link is up. */
	async refreshAppList(): Promise<void> {
		if (!this.state.companionConnected) throw new Error('Companion Link is not connected')
		await this.#fetchAppList()
	}

	// --- Pairing ---------------------------------------------------------------

	/** Step one: ask the Apple TV to display a PIN. */
	async beginPairing(protocol: 'airplay' | 'companion', target: DeviceTarget): Promise<void> {
		this.#cancelPairing()

		// AirPlay pairing needs nothing Bonjour could add, so skip the scan and its delay.
		const info: DiscoveredInfo =
			protocol === 'companion'
				? await this.#discover({ ...target, transport: 'companion' })
				: { name: '', address: target.host, port: target.port, deviceId: '', model: '' }

		const atv = new AppleTV(info)
		atv.on('error', () => {
			/* pairing sockets report through the rejected promise instead */
		})

		if (protocol === 'companion') {
			const port = info.companionPort
			if (!port) {
				throw new Error(`Could not find the Companion Link port for ${target.host} over Bonjour`)
			}
			const session = await withTimeout(
				atv.startCompanionPairing({ companionPort: port }),
				PAIR_TIMEOUT_MS,
				`request a PIN from ${target.host}`,
			)
			this.#pending = {
				protocol,
				finish: async (pin) => session.finish(pin),
				destroy: () => session.destroy(),
			}
		} else {
			const session = await withTimeout(atv.startPairing(), PAIR_TIMEOUT_MS, `request a PIN from ${target.host}`)
			this.#pending = {
				protocol,
				finish: async (pin) => session.finish(pin),
				destroy: () => session.destroy(),
			}
		}
	}

	/**
	 * Step two: exchange the PIN for long-term credentials. AirPlay and Companion Link
	 * credentials are kept side by side so both transports can be used at once.
	 */
	async completePairing(pin: string, existing: Credentials | undefined): Promise<Credentials> {
		const pending = this.#pending
		if (!pending) throw new Error('Pairing has not been started')

		// Taken rather than cancelled: the session is being used, not thrown away, so this must
		// not go through #cancelPairing() and report itself as abandoned.
		this.#pending = undefined

		try {
			const creds = await withTimeout(pending.finish(pin), PAIR_TIMEOUT_MS, 'complete pairing')

			if (pending.protocol === 'companion') {
				if (existing) {
					existing.companionCredentials = creds
					return existing
				}
				return new Credentials(creds, creds)
			}

			return new Credentials(creds, existing?.companionCredentials)
		} finally {
			try {
				pending.destroy()
			} catch {
				// the socket may already be gone
			}
		}
	}

	#cancelPairing(): void {
		const pending = this.#pending
		this.#pending = undefined
		if (!pending) return

		this.#host.log(
			'warn',
			`Pairing was abandoned before the ${pending.protocol === 'companion' ? 'Companion Link' : 'AirPlay'} ` +
				'PIN was entered',
		)

		try {
			pending.destroy()
		} catch {
			// the socket may already be gone
		}
	}
}

/** Rejects with a readable error rather than waiting on whatever timeout the socket has. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s trying to ${what}`)), ms)
	})

	try {
		return await Promise.race([promise, timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message
	return String(e)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const KNOWN_PLAYBACK_STATES: Record<number, PlaybackState | undefined> = {
	[PlaybackState.Unknown]: PlaybackState.Unknown,
	[PlaybackState.Playing]: PlaybackState.Playing,
	[PlaybackState.Paused]: PlaybackState.Paused,
	[PlaybackState.Stopped]: PlaybackState.Stopped,
	[PlaybackState.Interrupted]: PlaybackState.Interrupted,
	[PlaybackState.Seeking]: PlaybackState.Seeking,
}

function asPlaybackState(value: unknown): PlaybackState | undefined {
	const num = asNumber(value)
	if (num === undefined) return undefined

	return KNOWN_PLAYBACK_STATES[num] ?? PlaybackState.Unknown
}
