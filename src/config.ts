import { Regex, type SomeCompanionConfigField } from '@companion-module/base'
import type { Transport } from './device.js'

export type ModuleConfig = {
	/** `10.0.0.1:7000` when a bonjour device is picked, otherwise null/'' */
	bonjour_host: string | null
	host: string
	port: number

	transport: Transport

	pairPin: string
	/** Set by the user to throw away the stored credentials and pair again */
	repair: boolean
}

export type ModuleSecrets = {
	/**
	 * Serialised `Credentials` JSON from node-appletv-remote. Deliberately not exposed as a
	 * config field — Companion stores whatever the module saves, whether or not it is declared.
	 */
	credentials: string
}

/** Everything the config page needs to tell the user where they are in the process. */
export interface ConfigUiState {
	hasDevice: boolean
	airplayPaired: boolean
	companionPaired: boolean
	awaitingPin: 'airplay' | 'companion' | undefined
}

export function GetConfigFields(state: ConfigUiState): SomeCompanionConfigField[] {
	const fields: SomeCompanionConfigField[] = [
		{
			type: 'static-text',
			id: 'intro',
			label: 'Setup',
			width: 12,
			value: walkthrough(state),
		},
		{
			type: 'bonjour-device',
			id: 'bonjour_host',
			label: 'Apple TV',
			width: 6,
			description: 'Only Apple TVs are listed. Choose "Manual" to type an address instead.',
			disableAutoExpression: true,
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP',
			width: 4,
			default: '',
			regex: Regex.IP,
			isVisibleExpression: `!$(options:bonjour_host)`,
			disableAutoExpression: true,
		},
		{
			type: 'number',
			id: 'port',
			label: 'AirPlay port',
			width: 2,
			default: 7000,
			min: 1,
			max: 65535,
			isVisibleExpression: `!$(options:bonjour_host)`,
			disableAutoExpression: true,
		},
		{
			type: 'textinput',
			id: 'pairPin',
			label: pinLabel(state),
			width: 12,
			default: '',
			description: pinDescription(state),
			disableAutoExpression: true,
		},
	]

	// Nothing to re-pair until something has been paired, so the option only appears once it can do something.
	if (state.airplayPaired || state.companionPaired) {
		fields.push({
			type: 'checkbox',
			id: 'repair',
			label: 'Pair again',
			width: 12,
			default: false,
			description: 'Forgets the stored credentials and starts the pairing steps over. Tick and press Save.',
			disableAutoExpression: true,
		})
	}

	fields.push({
		type: 'dropdown',
		id: 'transport',
		label: 'Use',
		width: 12,
		default: 'both',
		choices: [
			{ id: 'both', label: 'Both — AirPlay for control, Companion Link for launching apps' },
			{ id: 'airplay', label: 'AirPlay only — remote keys, keyboard and now playing' },
			{ id: 'companion', label: 'Companion Link only — app launching and basic remote keys' },
		],
		description: 'Each connection is made, retried and reported on its own, so losing one does not disturb the other.',
		disableAutoExpression: true,
	})

	return fields
}

function walkthrough(state: ConfigUiState): string {
	if (state.awaitingPin === 'companion') {
		return (
			'<b>Step 3 of 3 — enter the second PIN.</b><br>' +
			'Your Apple TV is showing another PIN. This one pairs Companion Link, which is what launches apps. ' +
			'Type it into <b>Pairing PIN</b> and press Save.'
		)
	}

	if (state.awaitingPin === 'airplay') {
		return (
			'<b>Step 2 of 3 — enter the PIN.</b><br>' +
			'Your Apple TV is showing a four-digit PIN. Type it into <b>Pairing PIN</b> and press Save. ' +
			'A second PIN will follow.'
		)
	}

	if (!state.hasDevice) {
		return (
			'<b>Step 1 of 3 — choose your Apple TV.</b><br>' +
			'Pick it below and press Save. It must be awake and on the same network. Pairing starts by itself, ' +
			'and the Apple TV will show a PIN for you to type in.'
		)
	}

	if (state.airplayPaired && state.companionPaired) {
		return (
			'<b>Paired and ready.</b> AirPlay ✅ &nbsp; Companion Link ✅<br>' +
			'Nothing else to set up. Tick <b>Pair again</b> below if you ever need to start over.'
		)
	}

	if (state.airplayPaired) {
		return (
			'<b>Paired for remote control.</b> AirPlay ✅ &nbsp; Companion Link ❌<br>' +
			'Companion Link did not pair, so launching apps is unavailable — everything else works. ' +
			'Tick <b>Pair again</b> below to retry both.'
		)
	}

	return (
		'<b>Step 2 of 3 — press Save to start pairing.</b><br>' +
		'Your Apple TV will show a four-digit PIN to type in. Make sure it is awake first.'
	)
}

function pinLabel(state: ConfigUiState): string {
	if (state.awaitingPin === 'companion') return 'Pairing PIN (2 of 2 — Companion Link)'
	if (state.awaitingPin === 'airplay') return 'Pairing PIN (1 of 2 — AirPlay)'
	return 'Pairing PIN'
}

function pinDescription(state: ConfigUiState): string {
	if (state.awaitingPin) return 'Type the PIN shown on the Apple TV, then press Save.'
	if (state.airplayPaired && state.companionPaired) return 'Not needed — pairing is complete.'
	return 'Fill this in once the Apple TV shows a PIN.'
}

/**
 * Resolve the address to connect to, honouring the bonjour picker over the manual fields.
 * Tolerates a missing config: Companion asks for the config fields before `init` on a brand
 * new connection, to collect their defaults.
 */
export function resolveTarget(config: ModuleConfig | undefined): { host: string; port: number } | null {
	if (!config) return null

	const discovered = splitHostPort(config.bonjour_host)
	if (discovered) return discovered

	const host = (config.host ?? '').trim()
	if (!host) return null

	const port = config.port && config.port > 0 ? config.port : 7000
	return { host, port }
}

function splitHostPort(value: string | null | undefined): { host: string; port: number } | null {
	if (!value) return null

	const idx = value.lastIndexOf(':')
	if (idx <= 0) return null

	const host = value.slice(0, idx)
	const port = Number(value.slice(idx + 1))
	if (!host || !Number.isFinite(port) || port <= 0) return null

	return { host, port }
}
