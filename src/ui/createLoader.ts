const GPU = 0.04
const ASSETS = 0.88
const CELLS = 12

const CELL_HTML = '<div class="tw-boot-cell"><div class="tw-boot-fill"></div></div>'

/**
 * 资源下载进度。`ratio` 只覆盖城模这一段，GPU / 准备画面由 {@link BootHandle} 另加。
 */
export interface AssetProgress {
	/** 0～1，相对城模下载。 */
	ratio: number
	/** 当前阶段文案，如「城模」。 */
	stage: string
	/** 已下字节。 */
	loaded: number
	/** 总字节；未知时为 0。 */
	total: number
}

/**
 * 启动遮罩句柄。资源齐、首帧画完后 `dismiss`。
 */
export interface BootHandle {
	/** WebGPU `init()` 完成。 */
	gpuDone: () => void
	/** 城模等资源下载进度。 */
	assets: ( progress: AssetProgress ) => void
	/** 下载完，开始装配雨 / 湿膜 / 管线。 */
	prepare: () => void
	/** 条拉满。 */
	finish: () => void
	/** 启动失败，遮罩改成错误文案。 */
	fail: ( message: string ) => void
	/** 淡出并摘掉 `#boot`。 */
	dismiss: () => Promise<void>
}

function mb( n: number ): string {
	return `${ ( n / ( 1024 * 1024 ) ).toFixed( 1 ) } MB`
}

const BOOT_HTML = `
	<div class="tw-boot-card tw-glass">
		<div class="tw-boot-title">Rainy Night</div>
		<div class="tw-boot-stage">Loading scene</div>
		<div class="tw-boot-track">${ CELL_HTML.repeat( CELLS ) }</div>
		<div class="tw-boot-meta">
			<div class="tw-boot-sub"></div>
			<span class="tw-boot-pct">0%</span>
		</div>
	</div>`

function ensureBoot(): HTMLElement {
	let root = document.getElementById( 'boot' )
	if ( root === null ) {
		root = document.createElement( 'div' )
		root.id = 'boot'
		document.body.append( root )
	}
	root.className = 'tw-boot'
	root.setAttribute( 'role', 'progressbar' )
	root.setAttribute( 'aria-label', 'Loading scene' )
	root.setAttribute( 'aria-valuemin', '0' )
	root.setAttribute( 'aria-valuemax', '100' )
	root.setAttribute( 'aria-valuenow', '0' )
	if ( root.querySelectorAll( '.tw-boot-cell' ).length !== CELLS ) root.innerHTML = BOOT_HTML
	return root
}

/**
 * 绑到 `index.html` 里的 `#boot`。对照 interior-mapping-webgpu 的格子进度条。
 *
 * @returns 启动遮罩句柄。
 */
export function bindBoot(): BootHandle {

	const root = ensureBoot()
	const fills = [ ...root.querySelectorAll( '.tw-boot-fill' ) ] as HTMLElement[]
	const pct = root.querySelector( '.tw-boot-pct' ) as HTMLElement
	const stage = root.querySelector( '.tw-boot-stage' ) as HTMLElement
	const sub = root.querySelector( '.tw-boot-sub' ) as HTMLElement
	const reduceMotion = window.matchMedia( '(prefers-reduced-motion: reduce)' )

	let gone = false

	function setBar( t: number ) {
		const v = Math.max( 0, Math.min( 1, t ) )
		const scaled = v * CELLS
		const snap = reduceMotion.matches
		for ( let i = 0; i < fills.length; i ++ ) {
			let f = scaled - i
			if ( snap ) f = f >= 0.5 ? 1 : 0
			fills[ i ]!.style.transform = `scaleX(${ Math.max( 0, Math.min( 1, f ) ) })`
		}
		const n = Math.round( v * 100 )
		pct.textContent = `${ n }%`
		root.setAttribute( 'aria-valuenow', String( n ) )
	}

	stage.textContent = 'Initializing WebGPU'
	sub.textContent = ''
	setBar( 0 )

	return {
		gpuDone() {
			setBar( GPU )
		},
		assets( progress ) {
			stage.textContent = progress.stage
			sub.textContent = progress.total > 0
				? `${ progress.stage }  ${ mb( progress.loaded ) } / ${ mb( progress.total ) }`
				: ''
			setBar( GPU + ASSETS * progress.ratio )
		},
		prepare() {
			stage.textContent = 'Preparing the scene'
			sub.textContent = ''
			setBar( GPU + ASSETS )
		},
		finish() {
			setBar( 1 )
		},
		fail( message ) {
			if ( gone ) return
			root.setAttribute( 'role', 'alert' )
			root.removeAttribute( 'aria-valuenow' )
			const card = root.querySelector( '.tw-boot-card' )
			if ( card !== null ) {
				card.innerHTML = `<p class="tw-boot-fail">${ message }</p>`
			}
		},
		async dismiss() {
			if ( gone ) return
			gone = true
			root.classList.add( 'is-gone' )
			const reduce = window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches
			if ( ! reduce ) await new Promise( ( resolve ) => setTimeout( resolve, 280 ) )
			root.remove()
		},
	}

}
