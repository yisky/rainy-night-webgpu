/**
 * 雨夜环境声：小雨循环铺底，雷声按窗口偶发，不整段叠播。
 *
 * `light-rain.mp3` 约 104s、响度平稳，适合 loop。
 * `thunderstorm.mp3` 前 90s 有 7 声雷，之后是空白；整段 loop 会叠雨、后半死静。
 * 只把这 7 段窗口当雷，稀疏播放，相邻不重复。
 *
 * 浏览器要用户手势才能出声：第一次点击 / 按键解锁。右下角按钮可静音。
 * 不用 Three AudioListener，不占采样槽、不进主渲染。
 */

const RAIN_URL = '/audio/light-rain.mp3'
const THUNDER_URL = '/audio/thunderstorm.mp3'

/** 小雨铺底音量（元素 0~1）。源轨 RMS 约 −35dB，0.8 才能在巷里听清。 */
const RAIN_VOLUME = 0.8
/** 雷声音量。源峰值接近 0 dBFS，压住避免炸耳。 */
const THUNDER_VOLUME = 0.48
/** 雨声淡入秒数。 */
const RAIN_FADE_SEC = 2.4
/** 解锁后第一声雷的等待（秒）。 */
const FIRST_THUNDER_DELAY = [ 12, 20 ] as const
/** 两声雷之间的间隔（秒）。 */
const THUNDER_GAP = [ 22, 42 ] as const

/**
 * thunderstorm.mp3 里 RMS 突然抬到 −20dB 附近的 7 声雷。
 * 起点略早于攻击，终点收到余响；90s 后的静音不要用。
 */
const THUNDER_CLIPS: ReadonlyArray<readonly [ number, number ]> = [
	[ 3.6, 11.5 ],
	[ 19.2, 26.5 ],
	[ 29.4, 37.0 ],
	[ 41.2, 50.5 ],
	[ 55.2, 64.0 ],
	[ 68.8, 77.5 ],
	[ 81.8, 90.0 ],
]

/**
 * {@link createRainAudio} 句柄。
 */
export interface RainAudioHandle {
	/**
	 * 推进淡入与雷声调度。用墙钟秒，与灯笼微闪同一时钟。
	 *
	 * @param timeSec - `performance.now() * 0.001`
	 */
	update: ( timeSec: number ) => void
	/**
	 * 关掉自发雷。闪电接上之后由折线触发 {@link playThunderClip}。
	 *
	 * @param enabled - 为 false 时不再按间隔自己打雷。
	 */
	setAutoThunder: ( enabled: boolean ) => void
	/**
	 * 在 delay 秒后播一段 thunderstorm 窗口。静音或未解锁时忽略。
	 *
	 * @param delaySec - 光先声后的延迟。
	 */
	playThunderClip: ( delaySec?: number ) => void
	/** 停声、卸手势与按钮。 */
	dispose: () => void
}

function randRange( min: number, max: number ): number {
	return min + Math.random() * ( max - min )
}

function makeAudio( src: string, loop: boolean ): HTMLAudioElement {
	const el = new Audio()
	el.src = src
	el.loop = loop
	el.preload = 'auto'
	el.crossOrigin = 'anonymous'
	return el
}

/**
 * 搭雨声循环与偶发雷声，挂右下角静音按钮。
 */
export function createRainAudio(): RainAudioHandle {
	const rain = makeAudio( RAIN_URL, true )
	const thunder = makeAudio( THUNDER_URL, false )
	rain.volume = 0
	thunder.volume = THUNDER_VOLUME
	rain.load()
	thunder.load()

	const button = document.createElement( 'button' )
	button.type = 'button'
	button.className = 'tw-audio tw-glass'
	button.setAttribute( 'aria-label', '雨声' )
	button.title = '雨声'
	button.innerHTML = speakerSvg( false )
	document.body.append( button )

	let disposed = false
	let unlocked = false
	let wanted = true
	let rainTarget = 0
	let lastTime = 0
	let nextThunderAt = Number.POSITIVE_INFINITY
	let clipEnd = 0
	let lastClip = -1
	let thunderBusy = false
	let clipStarted = false
	let autoThunder = true
	let pendingThunderAt = Number.POSITIVE_INFINITY
	let playGen = 0

	const setButton = ( on: boolean ) => {
		button.classList.toggle( 'is-on', on )
		button.setAttribute( 'aria-pressed', on ? 'true' : 'false' )
		button.innerHTML = speakerSvg( on )
	}

	const stopThunder = () => {
		playGen += 1
		thunderBusy = false
		clipStarted = false
		clipEnd = 0
		thunder.pause()
	}

	const scheduleThunder = ( now: number, delay: readonly [ number, number ] ) => {
		nextThunderAt = now + randRange( delay[ 0 ], delay[ 1 ] )
	}

	const startRain = () => {
		rainTarget = RAIN_VOLUME
		const play = rain.play()
		if ( play ) play.catch( () => {} )
	}

	const unlock = () => {
		if ( disposed || unlocked ) return
		unlocked = true
		window.removeEventListener( 'pointerdown', unlock )
		window.removeEventListener( 'keydown', unlock )
		if ( ! wanted ) return
		startRain()
		if ( autoThunder ) scheduleThunder( performance.now() * 0.001, FIRST_THUNDER_DELAY )
		setButton( true )
	}

	const mute = () => {
		wanted = false
		rainTarget = 0
		rain.pause()
		stopThunder()
		nextThunderAt = Number.POSITIVE_INFINITY
		pendingThunderAt = Number.POSITIVE_INFINITY
		setButton( false )
	}

	const unmute = () => {
		wanted = true
		if ( ! unlocked ) {
			unlock()
			return
		}
		startRain()
		if ( autoThunder ) scheduleThunder( performance.now() * 0.001, FIRST_THUNDER_DELAY )
		setButton( true )
	}

	button.addEventListener( 'pointerdown', ( event ) => {
		event.stopPropagation()
	} )
	button.addEventListener( 'click', ( event ) => {
		event.stopPropagation()
		if ( wanted && unlocked ) mute()
		else unmute()
	} )

	window.addEventListener( 'pointerdown', unlock )
	window.addEventListener( 'keydown', unlock )

	const onVisibility = () => {
		if ( disposed || ! unlocked || ! wanted ) return
		if ( document.hidden ) {
			rain.pause()
			stopThunder()
		} else {
			startRain()
			if ( autoThunder ) scheduleThunder( performance.now() * 0.001, FIRST_THUNDER_DELAY )
		}
	}
	document.addEventListener( 'visibilitychange', onVisibility )

	const playClip = ( start: number, end: number ) => {
		const gen = ++playGen
		thunderBusy = true
		clipStarted = false
		clipEnd = end
		thunder.volume = THUNDER_VOLUME
		const begin = () => {
			if ( disposed || gen !== playGen ) return
			const play = thunder.play()
			if ( ! play ) {
				clipStarted = true
				return
			}
			play.then( () => {
				if ( gen === playGen ) clipStarted = true
			} ).catch( () => {
				if ( gen === playGen ) {
					thunderBusy = false
					clipStarted = false
				}
			} )
		}
		thunder.pause()
		try {
			thunder.currentTime = start
		} catch {
			thunderBusy = false
			return
		}
		if ( thunder.seeking ) {
			thunder.addEventListener( 'seeked', begin, { once: true } )
		} else {
			begin()
		}
	}

	const firePendingClip = ( timeSec: number ) => {
		if ( thunder.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ) {
			if ( autoThunder ) nextThunderAt = timeSec + 2
			else pendingThunderAt = timeSec + 2
			return
		}
		let index = Math.floor( Math.random() * THUNDER_CLIPS.length )
		if ( index === lastClip && THUNDER_CLIPS.length > 1 ) {
			index = ( index + 1 ) % THUNDER_CLIPS.length
		}
		lastClip = index
		const clip = THUNDER_CLIPS[ index ]!
		playClip( clip[ 0 ], clip[ 1 ] )
	}

	return {
		update: ( timeSec: number ) => {
			if ( disposed ) return
			const dt = lastTime > 0 ? Math.min( 0.08, Math.max( 0, timeSec - lastTime ) ) : 0
			lastTime = timeSec

			if ( dt > 0 && rain.volume !== rainTarget ) {
				const step = dt / RAIN_FADE_SEC
				if ( rain.volume < rainTarget ) {
					rain.volume = Math.min( rainTarget, rain.volume + step * RAIN_VOLUME )
				} else {
					rain.volume = Math.max( rainTarget, rain.volume - step * RAIN_VOLUME )
				}
			}

			if ( ! unlocked || ! wanted || document.hidden ) return

			if ( thunderBusy ) {
				if ( clipStarted && ( thunder.paused || thunder.currentTime >= clipEnd ) ) {
					stopThunder()
					if ( autoThunder ) scheduleThunder( timeSec, THUNDER_GAP )
				}
				return
			}

			if ( ! autoThunder ) {
				if ( timeSec >= pendingThunderAt ) {
					pendingThunderAt = Number.POSITIVE_INFINITY
					firePendingClip( timeSec )
				}
				return
			}

			if ( timeSec < nextThunderAt ) return
			firePendingClip( timeSec )
		},
		setAutoThunder: ( enabled: boolean ) => {
			autoThunder = enabled
			if ( ! enabled ) {
				nextThunderAt = Number.POSITIVE_INFINITY
			}
		},
		playThunderClip: ( delaySec = 0 ) => {
			if ( disposed || ! wanted ) return
			if ( thunderBusy ) stopThunder()
			pendingThunderAt = ( lastTime > 0 ? lastTime : performance.now() * 0.001 ) + Math.max( 0, delaySec )
		},
		dispose: () => {
			if ( disposed ) return
			disposed = true
			window.removeEventListener( 'pointerdown', unlock )
			window.removeEventListener( 'keydown', unlock )
			document.removeEventListener( 'visibilitychange', onVisibility )
			rain.pause()
			stopThunder()
			rain.src = ''
			thunder.src = ''
			button.remove()
		},
	}
}

/**
 * 喇叭图标。开 / 关两态。
 *
 * @param on - 正在出声。
 */
function speakerSvg( on: boolean ): string {
	if ( on ) {
		return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9v6h3.2L12 19.2V4.8L7.2 9H4zm11.5 3c0-1.8-1-3.3-2.5-4v8c1.5-.7 2.5-2.2 2.5-4zm-2.5-7v2.1c2.9.9 5 3.5 5 6.9s-2.1 6-5 6.9V20c4-.9 7-4.5 7-8.9S16.5 4.1 13 3z"/></svg>`
	}
	return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9v6h3.2L12 19.2V4.8L7.2 9H4zm11.7-.3 1.4 1.4L15.8 12l1.3 1.9-1.4 1.4L14.4 13l-1.8 1.8-1.4-1.4 1.8-1.8-1.8-1.8 1.4-1.4 1.8 1.8 1.3-1.9z"/></svg>`
}
