import type ModuleInstance from './main.js'
import { PlaybackState, type PowerState } from './device.js'

export type VariablesSchema = {
	connected: string
	companion_connected: string
	device_name: string
	device_model: string
	device_ip: string

	power_state: string
	playback_state: string
	app_name: string
	app_bundle_id: string

	media_title: string
	media_artist: string
	media_album: string

	media_duration: number
	media_duration_hms: string
	media_elapsed: number
	media_elapsed_hms: string
	media_remaining: number
	media_remaining_hms: string
	media_percent: number
	media_playback_rate: number
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({
		connected: { name: 'Connected (true/false)' },
		companion_connected: { name: 'Companion Link connected (true/false)' },
		device_name: { name: 'Device name' },
		device_model: { name: 'Device model' },
		device_ip: { name: 'Device IP address' },

		power_state: { name: 'Power state (On/Asleep/Unknown)' },
		playback_state: { name: 'Playback state' },
		app_name: { name: 'Foreground app name' },
		app_bundle_id: { name: 'Foreground app bundle ID' },

		media_title: { name: 'Title' },
		media_artist: { name: 'Artist' },
		media_album: { name: 'Album' },

		media_duration: { name: 'Duration (seconds)' },
		media_duration_hms: { name: 'Duration (h:mm:ss)' },
		media_elapsed: { name: 'Elapsed (seconds)' },
		media_elapsed_hms: { name: 'Elapsed (h:mm:ss)' },
		media_remaining: { name: 'Remaining (seconds)' },
		media_remaining_hms: { name: 'Remaining (h:mm:ss)' },
		media_percent: { name: 'Progress (percent)' },
		media_playback_rate: { name: 'Playback rate' },
	})
}

export function UpdateVariableValues(self: ModuleInstance): void {
	const state = self.device.state
	const elapsed = self.device.elapsed
	const duration = state.duration
	const remaining = duration > 0 ? Math.max(duration - elapsed, 0) : 0

	self.setVariableValues({
		connected: state.connected ? 'true' : 'false',
		companion_connected: state.companionConnected ? 'true' : 'false',
		device_name: state.name,
		device_model: state.model,
		device_ip: state.host,

		power_state: powerStateLabel(state.powerState),
		playback_state: playbackStateLabel(state.playbackState),
		app_name: state.appName,
		app_bundle_id: state.appBundleId,

		media_title: state.title,
		media_artist: state.artist,
		media_album: state.album,

		media_duration: round(duration),
		media_duration_hms: toHms(duration),
		media_elapsed: round(elapsed),
		media_elapsed_hms: toHms(elapsed),
		media_remaining: round(remaining),
		media_remaining_hms: toHms(remaining),
		media_percent: duration > 0 ? round((elapsed / duration) * 100, 1) : 0,
		media_playback_rate: state.playbackRate,
	})
}

export function powerStateLabel(state: PowerState): string {
	switch (state) {
		case 'on':
			return 'On'
		case 'off':
			return 'Asleep'
		default:
			return 'Unknown'
	}
}

export function playbackStateLabel(state: PlaybackState): string {
	switch (state) {
		case PlaybackState.Playing:
			return 'Playing'
		case PlaybackState.Paused:
			return 'Paused'
		case PlaybackState.Stopped:
			return 'Stopped'
		case PlaybackState.Interrupted:
			return 'Interrupted'
		case PlaybackState.Seeking:
			return 'Seeking'
		default:
			return 'Unknown'
	}
}

function round(value: number, decimals = 0): number {
	const factor = 10 ** decimals
	return Math.round(value * factor) / factor
}

/** `1:02:03` for anything over an hour, `2:03` otherwise. */
function toHms(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'

	const total = Math.floor(seconds)
	const hours = Math.floor(total / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const secs = total % 60

	const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
	const ss = String(secs).padStart(2, '0')

	return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
