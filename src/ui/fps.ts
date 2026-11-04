/**
 * @file 左上角帧率浮层。
 * 数字每 250ms 刷新一次；火花线每 100ms 记该桶里最慢的一帧，最多 60 个点。
 * 从 workshop `src/ui/fps.ts` 移植，去掉对 `@tx3d/core` Script 的依赖。
 */

/**
 * 帧率档位。≥50 为 `good`，≥30 为 `warn`，否则 `bad`。
 */
type Level = 'good' | 'warn' | 'bad'

/**
 * 各档位对应的 RGB，给数字颜色和火花线用。
 */
const RGB: Record<Level, string> = {
	good: '95, 227, 212',
	warn: '255, 184, 107',
	bad: '255, 122, 133',
}

/**
 * 帧率浮层句柄。
 */
export interface FpsHandle {
	/**
	 * 喂入本帧耗时（毫秒）和上一帧 draw call 次数。
	 * @param ms 本帧耗时。≤ 0 会忽略。
	 * @param drawCalls 本帧 draw call。省略时不改 `draw`。
	 */
	frame: ( ms: number, drawCalls?: number ) => void
	/** 从文档里摘掉浮层。 */
	dispose: () => void
}

/**
 * 创建左上角帧率浮层，并挂到 `document.body`。
 *
 * @returns 每帧调用 `frame`，卸载时调用 `dispose`。
 */
export function createFps(): FpsHandle {

	const root = document.createElement( 'div' )
	root.className = 'tw-stats tw-glass'
	root.dataset.level = 'good'
	root.setAttribute( 'aria-hidden', 'true' )
	root.innerHTML = `
		<div class="tw-stats-main"><span class="tw-fps">--</span><span class="tw-fps-unit">fps</span></div>
		<canvas class="tw-spark"></canvas>
		<div class="tw-stats-sub"><span class="tw-kv"><span class="tw-k">frame</span><span class="tw-v">--</span></span><span class="tw-kv"><span class="tw-k">draw</span><span class="tw-v tw-draw">--</span></span></div>`
	document.body.append( root )

	const fpsEl = root.querySelector( '.tw-fps' ) as HTMLSpanElement
	const msEl = root.querySelector( '.tw-v' ) as HTMLSpanElement
	const drawEl = root.querySelector( '.tw-draw' ) as HTMLSpanElement
	const spark = root.querySelector( '.tw-spark' ) as HTMLCanvasElement
	/** 火花线采样，单位毫秒，最多 60 个。 */
	const samples: number[] = []
	/** 当前 100ms 桶里最慢的一帧。 */
	let worst = 0
	/** 当前火花线桶的起始时刻。 */
	let bucket = performance.now()
	/** 上次刷新数字的时刻。 */
	let shown = bucket
	/** 当前 250ms 窗口内的帧耗时合计。 */
	let sum = 0
	/** 当前 250ms 窗口内的帧数。 */
	let count = 0
	/** 当前档位，用来决定颜色。 */
	let level: Level = 'good'
	/** 已经写到 DOM 上的 fps 文本，避免重复赋值。 */
	let text = ''
	/** 丢掉第一帧，避免首帧间隔把数字拉爆。 */
	let skip = true

	/**
	 * 记一帧耗时，按间隔刷新数字和火花线。
	 */
	function frame( ms: number, drawCalls?: number ): void {

		if ( !( ms > 0 ) ) return
		if ( skip ) {
			skip = false
			return
		}

		const now = performance.now()
		worst = Math.max( worst, ms )
		sum += ms
		count ++
		if ( now - bucket >= 100 && worst > 0 ) {
			bucket = now
			samples.push( worst )
			if ( samples.length > 60 ) samples.shift()
			worst = 0
			draw()
		}

		if ( now - shown < 250 || count === 0 ) return
		shown = now
		const fps = 1000 / ( sum / count )
		sum = 0
		count = 0
		const nextText = String( Math.round( fps ) )
		if ( nextText !== text ) {
			text = nextText
			fpsEl.textContent = nextText
		}

		const nextLevel: Level = fps >= 50 ? 'good' : fps >= 30 ? 'warn' : 'bad'
		if ( nextLevel !== level ) {
			level = nextLevel
			root.dataset.level = nextLevel
			draw()
		}

		msEl.textContent = `${ ( 1000 / fps ).toFixed( 1 ) } ms`
		if ( drawCalls !== undefined ) drawEl.textContent = String( drawCalls )

	}

	/**
	 * 按 `samples` 重绘火花线。不足两个点、或画布还没有尺寸时不画。
	 */
	function draw(): void {

		const w = spark.clientWidth
		const h = spark.clientHeight
		if ( !w || !h || samples.length < 2 ) return
		const dpr = Math.min( 2, window.devicePixelRatio || 1 )
		const W = Math.round( w * dpr )
		const H = Math.round( h * dpr )
		if ( spark.width !== W || spark.height !== H ) {
			spark.width = W
			spark.height = H
		}

		const g = spark.getContext( '2d' )
		if ( !g ) return
		g.setTransform( dpr, 0, 0, dpr, 0, 0 )
		g.clearRect( 0, 0, w, h )
		const top = Math.max( 34, ...samples ) * 1.1
		const Y = ( v: number ) => h - 1.5 - ( Math.min( v, top ) / top ) * ( h - 4 )
		const X = ( i: number ) => w - 2 - ( samples.length - 1 - i ) * ( ( w - 4 ) / 59 )
		g.strokeStyle = 'rgba(200, 230, 240, 0.18)'
		g.lineWidth = 1
		g.setLineDash( [ 2, 3 ] )
		g.beginPath()
		const yr = Math.round( Y( 1000 / 60 ) ) + 0.5
		g.moveTo( 0, yr )
		g.lineTo( w, yr )
		g.stroke()
		g.setLineDash( [] )

		const rgb = RGB[ level ]
		const trace = () => {
			g.beginPath()
			samples.forEach( ( v, i ) => ( i ? g.lineTo( X( i ), Y( v ) ) : g.moveTo( X( i ), Y( v ) ) ) )
		}

		const grad = g.createLinearGradient( 0, 0, 0, h )
		grad.addColorStop( 0, `rgba(${ rgb }, 0.32)` )
		grad.addColorStop( 1, `rgba(${ rgb }, 0)` )
		trace()
		g.lineTo( X( samples.length - 1 ), h )
		g.lineTo( X( 0 ), h )
		g.closePath()
		g.fillStyle = grad
		g.fill()
		trace()
		g.strokeStyle = `rgba(${ rgb }, 0.95)`
		g.lineWidth = 1.25
		g.lineJoin = 'round'
		g.stroke()
		const last = samples.length - 1
		g.fillStyle = `rgb(${ rgb })`
		g.beginPath()
		g.arc( X( last ), Y( samples[ last ] ), 1.8, 0, Math.PI * 2 )
		g.fill()

	}

	return {
		frame,
		dispose() {
			root.remove()
		},
	}

}
