import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { Credentials } from 'node-appletv-remote'
import { GetConfigFields, resolveTarget, type ModuleConfig, type ModuleSecrets, type PairingStatus } from './config.js'
import { UpdateVariableDefinitions, UpdateVariableValues, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { AppleTvDevice, errorMessage, type DeviceHost, type DeviceTarget } from './device.js'
import { captureLibraryLogging } from './library-logging.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

export default class ModuleInstance extends InstanceBase<ModuleSchema> implements DeviceHost {
	config!: ModuleConfig // Setup in init()
	secrets!: ModuleSecrets // Setup in init()

	readonly device = new AppleTvDevice(this)

	#tickTimer: NodeJS.Timeout | undefined
	#refreshTimer: NodeJS.Timeout | undefined
	#releaseLibraryLogging: (() => void) | undefined

	/** Everything the running connection depends on, so a no-op save does not restart it. */
	#connectionSignature: string | undefined

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		this.#releaseLibraryLogging = captureLibraryLogging((message) => this.log('debug', message))

		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()

		// The elapsed time is extrapolated locally between the updates the Apple TV pushes.
		this.#tickTimer = setInterval(() => {
			if (this.device.state.playbackRate !== 0) UpdateVariableValues(this)
		}, 1000)

		await this.applyConfig(config, secrets)
	}

	async destroy(): Promise<void> {
		if (this.#tickTimer) clearInterval(this.#tickTimer)
		if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
		this.#tickTimer = undefined
		this.#refreshTimer = undefined

		this.#releaseLibraryLogging?.()
		this.#releaseLibraryLogging = undefined

		await this.device.stop()
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		await this.applyConfig(config, secrets)
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields(this.#pairingStatus())
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	// --- Configuration ---------------------------------------------------------

	/**
	 * Decides what the connection should be doing for a given config. Pairing takes priority:
	 * while a PIN is outstanding the connection is left alone so the pairing socket survives
	 * the save that carries the PIN.
	 */
	private async applyConfig(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets

		const target = resolveTarget(config)
		if (!target) {
			await this.#shutdown()
			this.updateStatus(InstanceStatus.BadConfig, 'No Apple TV selected')
			this.syncVariablesAndFeedbacks()
			return
		}

		const deviceTarget: DeviceTarget = {
			host: target.host,
			port: target.port,
			companionPort: Math.max(config.companionPort ?? 0, 0),
			transport: config.transport ?? 'both',
			reconnectIntervalMs: Math.max(config.reconnectInterval ?? 10, 2) * 1000,
			pollIntervalMs: Math.max(config.pollInterval ?? 0, 0) * 1000,
		}

		const pin = (config.pairPin ?? '').trim()
		if (pin) {
			await this.#completePairing(pin, deviceTarget)
			return
		}

		if (config.pairStart && !this.device.hasPendingPairing) {
			await this.#beginPairing(deviceTarget)
			return
		}

		if (this.device.hasPendingPairing) {
			this.updateStatus(InstanceStatus.Connecting, this.#pinPrompt())
			return
		}

		await this.#connect(deviceTarget)
	}

	/**
	 * Saving the config from inside the module comes back as a `configUpdated`, so restarting
	 * unconditionally would tear down a healthy connection moments after pairing succeeded.
	 */
	async #connect(target: DeviceTarget, force = false): Promise<void> {
		const credentials = this.#readCredentials()
		if (!credentials) {
			await this.#shutdown()
			this.updateStatus(InstanceStatus.BadConfig, 'Not paired — tick "Begin pairing" and save')
			this.syncVariablesAndFeedbacks()
			return
		}

		const signature = JSON.stringify([target, this.secrets.credentials])
		if (!force && signature === this.#connectionSignature) {
			this.log('debug', 'Config saved with no connection changes, leaving the connection alone')
			return
		}
		this.#connectionSignature = signature

		this.updateStatus(InstanceStatus.Connecting)
		await this.device.start(target, credentials)
	}

	async #shutdown(): Promise<void> {
		this.#connectionSignature = undefined
		await this.device.stop()
	}

	/** Pairing always covers both protocols, starting with AirPlay. */
	async #beginPairing(target: DeviceTarget): Promise<void> {
		await this.#shutdown()
		this.updateStatus(InstanceStatus.Connecting, 'Requesting a pairing PIN')

		try {
			await this.device.beginPairing('airplay', target)
			this.log('info', 'Pairing started — enter the first PIN (AirPlay) shown on the Apple TV')
			this.updateStatus(InstanceStatus.Connecting, this.#pinPrompt())
		} catch (e) {
			this.log('error', `Could not start pairing: ${errorMessage(e)}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, `Pairing failed: ${errorMessage(e)}`)
		}

		// Clear the flag so the next save (the one carrying the PIN) does not restart pairing.
		this.saveConfig({ ...this.config, pairStart: false }, undefined)
	}

	async #completePairing(pin: string, target: DeviceTarget): Promise<void> {
		const protocol = this.device.pendingPairingProtocol
		if (!protocol) {
			this.log('error', 'A PIN was entered but pairing has not been started — tick "Begin pairing" first')
			this.saveConfig({ ...this.config, pairStart: false, pairPin: '' }, undefined)
			this.updateStatus(InstanceStatus.BadConfig, 'Pairing was not started')
			return
		}

		let credentials
		try {
			credentials = await this.device.completePairing(pin, this.#readCredentials())
		} catch (e) {
			this.log('error', `Pairing failed: ${errorMessage(e)}`)
			this.saveConfig({ ...this.config, pairStart: false, pairPin: '' }, undefined)
			this.updateStatus(InstanceStatus.AuthenticationFailure, `Pairing failed: ${errorMessage(e)}`)
			return
		}

		const serialised = credentials.serialize()
		this.log('info', `${protocol === 'companion' ? 'Companion Link' : 'AirPlay'} pairing succeeded`)
		this.secrets = { credentials: serialised }
		this.saveConfig({ ...this.config, pairStart: false, pairPin: '' }, { credentials: serialised })

		// AirPlay is only half the job: go straight on to the Companion Link PIN.
		if (protocol === 'airplay' && (await this.#beginCompanionPairing(target))) return

		await this.#connect(target, true)
	}

	/**
	 * Returns true when the Apple TV is now showing the second PIN. A failure here is not fatal —
	 * the AirPlay credentials are already saved, so the connection carries on without Companion Link.
	 */
	async #beginCompanionPairing(target: DeviceTarget): Promise<boolean> {
		try {
			await this.device.beginPairing('companion', target)
			this.log('info', 'Now enter the second PIN (Companion Link) shown on the Apple TV')
			this.updateStatus(InstanceStatus.Connecting, this.#pinPrompt())
			return true
		} catch (e) {
			this.log('warn', `Companion Link pairing could not be started (${errorMessage(e)}); continuing with AirPlay only`)
			return false
		}
	}

	#pinPrompt(): string {
		return this.device.pendingPairingProtocol === 'companion'
			? 'Enter the second PIN (Companion Link)'
			: 'Enter the first PIN (AirPlay)'
	}

	#readCredentials(): Credentials | undefined {
		const raw = (this.secrets?.credentials ?? '').trim()
		if (!raw) return undefined

		try {
			return Credentials.deserialize(raw)
		} catch (e) {
			this.log('error', `Stored credentials could not be read: ${errorMessage(e)}`)
			return undefined
		}
	}

	#pairingStatus(): PairingStatus {
		const credentials = this.#readCredentials()
		return {
			airplay: credentials !== undefined,
			companion: credentials?.companionCredentials !== undefined,
		}
	}

	// --- Device host callbacks -------------------------------------------------

	onConnectionChanged(): void {
		if (this.device.hasPendingPairing) {
			this.updateStatus(InstanceStatus.Connecting, this.#pinPrompt())
		} else if (this.device.isOnline) {
			// With both transports selected, one of them being down is worth surfacing.
			const missing: string[] = []
			if (this.device.wantsAirplay && !this.device.isConnected) missing.push('AirPlay')
			if (this.device.wantsCompanion && !this.device.isCompanionConnected) missing.push('Companion Link')

			this.updateStatus(InstanceStatus.Ok, missing.length > 0 ? `${missing.join(' and ')} unavailable` : null)
		} else {
			this.updateStatus(InstanceStatus.Disconnected)
		}

		this.syncVariablesAndFeedbacks()
	}

	onStateChanged(): void {
		this.syncVariablesAndFeedbacks()
	}

	syncVariablesAndFeedbacks(): void {
		UpdateVariableValues(this)
		this.checkFeedbacks('connected', 'companion_connected', 'playback_state', 'media_matches')
	}

	/**
	 * The Apple TV pushes state changes, but not always promptly after a button press,
	 * so nudge it a moment later. Repeated presses collapse into one request.
	 */
	scheduleStateRefresh(delayMs = 800): void {
		if (this.#refreshTimer) clearTimeout(this.#refreshTimer)

		this.#refreshTimer = setTimeout(() => {
			this.#refreshTimer = undefined
			void this.device.refreshState()
		}, delayMs)
	}

	async restartConnection(): Promise<void> {
		this.#connectionSignature = undefined
		await this.applyConfig(this.config, this.secrets)
	}
}
