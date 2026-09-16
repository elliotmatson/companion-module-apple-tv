import { combineRgb } from '@companion-module/base'
import type ModuleInstance from './main.js'
import { PlaybackState, type PowerState } from './device.js'

export type MediaField = 'title' | 'artist' | 'album' | 'app_name' | 'app_bundle_id'
export type MatchMode = 'equals' | 'contains'

export type FeedbacksSchema = {
	connected: { type: 'boolean'; options: Record<string, never> }
	companion_connected: { type: 'boolean'; options: Record<string, never> }
	playback_state: { type: 'boolean'; options: { state: PlaybackState } }
	power_state: { type: 'boolean'; options: { state: PowerState } }
	media_matches: { type: 'boolean'; options: { field: MediaField; mode: MatchMode; value: string } }
}

const green = combineRgb(0, 153, 51)
const black = combineRgb(0, 0, 0)
const white = combineRgb(255, 255, 255)
const red = combineRgb(153, 0, 0)

export function UpdateFeedbacks(self: ModuleInstance): void {
	self.setFeedbackDefinitions({
		connected: {
			name: 'Connected to the Apple TV',
			type: 'boolean',
			defaultStyle: { bgcolor: green, color: white },
			options: [],
			callback: () => self.device.isConnected,
		},

		companion_connected: {
			name: 'Companion Link connected',
			type: 'boolean',
			defaultStyle: { bgcolor: green, color: white },
			options: [],
			callback: () => self.device.isCompanionConnected,
		},

		playback_state: {
			name: 'Playback state is',
			type: 'boolean',
			defaultStyle: { bgcolor: green, color: black },
			options: [
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: PlaybackState.Playing,
					choices: [
						{ id: PlaybackState.Playing, label: 'Playing' },
						{ id: PlaybackState.Paused, label: 'Paused' },
						{ id: PlaybackState.Stopped, label: 'Stopped' },
						{ id: PlaybackState.Interrupted, label: 'Interrupted' },
						{ id: PlaybackState.Seeking, label: 'Seeking' },
						{ id: PlaybackState.Unknown, label: 'Unknown' },
					],
				},
			],
			callback: (feedback) => self.device.state.playbackState === feedback.options.state,
		},

		power_state: {
			name: 'Apple TV is',
			description: 'Needs Companion Link — the Apple TV reports this over that connection only.',
			type: 'boolean',
			defaultStyle: { bgcolor: green, color: black },
			options: [
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'on',
					choices: [
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Asleep' },
						{ id: 'unknown', label: 'Unknown' },
					],
				},
			],
			callback: (feedback) => self.device.state.powerState === feedback.options.state,
		},

		media_matches: {
			name: 'Now playing matches',
			description: 'Compare a now-playing field against a value. The comparison ignores case.',
			type: 'boolean',
			defaultStyle: { bgcolor: red, color: white },
			options: [
				{
					id: 'field',
					type: 'dropdown',
					label: 'Field',
					default: 'app_bundle_id',
					choices: [
						{ id: 'title', label: 'Title' },
						{ id: 'artist', label: 'Artist' },
						{ id: 'album', label: 'Album' },
						{ id: 'app_name', label: 'App name' },
						{ id: 'app_bundle_id', label: 'App bundle ID' },
					],
				},
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Comparison',
					default: 'equals',
					choices: [
						{ id: 'equals', label: 'Equals' },
						{ id: 'contains', label: 'Contains' },
					],
				},
				{
					id: 'value',
					type: 'textinput',
					label: 'Value',
					default: '',
					useVariables: true,
				},
			],
			callback: (feedback) => {
				const target = (feedback.options.value ?? '').trim().toLowerCase()
				if (!target) return false

				const actual = readMediaField(self, feedback.options.field).toLowerCase()
				if (!actual) return false

				return feedback.options.mode === 'contains' ? actual.includes(target) : actual === target
			},
		},
	})
}

function readMediaField(self: ModuleInstance, field: MediaField): string {
	const state = self.device.state
	switch (field) {
		case 'title':
			return state.title
		case 'artist':
			return state.artist
		case 'album':
			return state.album
		case 'app_name':
			return state.appName
		case 'app_bundle_id':
			return state.appBundleId
		default:
			return ''
	}
}
