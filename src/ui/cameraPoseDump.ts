/**
 * @file 临时相机视点截取 + 地面点拾取。
 * 截取视点：转到视角后点按钮或按 C。
 * 拾取点：点亮「拾取点」后单击地面，只记命中坐标；走路高度之后再加。
 */

import {
	Mesh,
	MeshBasicMaterial,
	Object3D,
	PerspectiveCamera,
	Raycaster,
	Scene,
	SphereGeometry,
	Vector2,
	Vector3,
} from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { SKY_LAYER } from '../atmosphere/createNightSky'
import { LIGHTNING_LAYER } from '../lightning/createLightning'
import { RAIN_LAYER } from '../rain/createRain'

/**
 * {@link createCameraPoseDump} 需要的实时相机、轨道和拾取根。
 */
export interface CameraPoseDumpOptions {
	camera: PerspectiveCamera
	controls: OrbitControls
	canvas: HTMLCanvasElement
	scene: Scene
}

/**
 * 临时截取浮层句柄。
 */
export interface CameraPoseDumpHandle {
	/** 从文档摘掉浮层、快捷键和标记球。 */
	dispose: () => void
}

function fmt( n: number ): string {
	return String( Math.round( n * 1000 ) / 1000 )
}

/**
 * 左下角玻璃浮层：截取机位，或 Shift 单击 / 拾取模式点地面。
 *
 * @param options - 主相机、轨道、画布、场景
 */
export function createCameraPoseDump( options: CameraPoseDumpOptions ): CameraPoseDumpHandle {
	const { camera, controls, canvas, scene } = options

	const root = document.createElement( 'div' )
	root.className = 'tw-camdump tw-glass'
	root.innerHTML = `
		<div class="tw-camdump-row">
			<button type="button" class="tw-camdump-btn" data-act="pose">截取视点</button>
			<button type="button" class="tw-camdump-btn" data-act="pick">拾取点</button>
			<button type="button" class="tw-camdump-btn" data-act="undo">撤销</button>
			<button type="button" class="tw-camdump-btn" data-act="copy">复制点</button>
			<button type="button" class="tw-camdump-btn" data-act="clear">清空</button>
		</div>
		<pre class="tw-camdump-pre">转到视角点「截取视点」或 C；点亮「拾取点」后单击地面</pre>
		<span class="tw-camdump-hint">拾取的是地表坐标，步行高度之后再加</span>`
	document.body.append( root )

	const poseBtn = root.querySelector( '[data-act="pose"]' ) as HTMLButtonElement
	const pickBtn = root.querySelector( '[data-act="pick"]' ) as HTMLButtonElement
	const undoBtn = root.querySelector( '[data-act="undo"]' ) as HTMLButtonElement
	const copyBtn = root.querySelector( '[data-act="copy"]' ) as HTMLButtonElement
	const clearBtn = root.querySelector( '[data-act="clear"]' ) as HTMLButtonElement
	const pre = root.querySelector( '.tw-camdump-pre' ) as HTMLPreElement

	const points: Vector3[] = []
	const markers: Mesh[] = []
	const markerGeo = new SphereGeometry( 0.28, 12, 8 )
	const markerMat = new MeshBasicMaterial( { color: 0x5fe3d4, depthTest: false } )
	const raycaster = new Raycaster()
	const ndc = new Vector2()
	let picking = false

	const dumpPoints = (): string => {
		if ( points.length === 0 ) return '还没有拾取点'
		return points.map( ( p, i ) => (
			`P${ i }  ${ fmt( p.x ) }, ${ fmt( p.y ) }, ${ fmt( p.z ) }`
		) ).join( '\n' )
	}

	const refresh = ( extra?: string ) => {
		pre.textContent = extra ?? dumpPoints()
	}

	const skipPick = ( obj: Object3D ): boolean => {
		if ( obj.userData.pickIgnore ) return true
		if ( obj.layers.isEnabled( RAIN_LAYER ) ) return true
		if ( obj.layers.isEnabled( SKY_LAYER ) ) return true
		if ( obj.layers.isEnabled( LIGHTNING_LAYER ) ) return true
		return false
	}

	const addMarker = ( p: Vector3 ) => {
		const mesh = new Mesh( markerGeo, markerMat )
		mesh.position.copy( p )
		mesh.renderOrder = 999
		mesh.userData.pickIgnore = true
		scene.add( mesh )
		markers.push( mesh )
	}

	const popMarker = () => {
		const mesh = markers.pop()
		if ( ! mesh ) return
		scene.remove( mesh )
	}

	const clearMarkers = () => {
		for ( const mesh of markers ) scene.remove( mesh )
		markers.length = 0
	}

	const snapshotPose = (): string => {
		const p = camera.position
		const t = controls.target
		return [
			`camera.position.set( ${ fmt( p.x ) }, ${ fmt( p.y ) }, ${ fmt( p.z ) } )`,
			`controls.target.set( ${ fmt( t.x ) }, ${ fmt( t.y ) }, ${ fmt( t.z ) } )`,
		].join( '\n' )
	}

	const flash = ( btn: HTMLButtonElement, ok: string, restore: string ) => {
		btn.textContent = ok
		window.setTimeout( () => {
			if ( btn.isConnected ) btn.textContent = restore
		}, 1200 )
	}

	const copyText = ( text: string, btn: HTMLButtonElement, restore: string ) => {
		const done = navigator.clipboard?.writeText( text )
		if ( done ) {
			void done.then( () => flash( btn, '已复制', restore ) ).catch( () => {} )
		}
	}

	const capturePose = (): void => {
		const text = snapshotPose()
		refresh( text )
		console.info( '[rainy-night] camera pose\n' + text )
		copyText( text, poseBtn, '截取视点' )
	}

	const copyPoints = (): void => {
		if ( points.length === 0 ) {
			refresh( '还没有拾取点' )
			return
		}
		const text = 'path = [\n' + points.map( ( p ) => (
			`  [ ${ fmt( p.x ) }, ${ fmt( p.y ) }, ${ fmt( p.z ) } ],`
		) ).join( '\n' ) + '\n]'
		refresh( dumpPoints() )
		console.info( '[rainy-night] path points\n' + text )
		copyText( text, copyBtn, '复制点' )
	}

	const setPicking = ( on: boolean ) => {
		picking = on
		pickBtn.classList.toggle( 'is-on', on )
		pickBtn.textContent = on ? '拾取中' : '拾取点'
		controls.enabled = ! on
		canvas.style.cursor = on ? 'crosshair' : ''
	}

	const pickAt = ( event: PointerEvent ) => {
		const rect = canvas.getBoundingClientRect()
		if ( rect.width < 1 || rect.height < 1 ) return
		ndc.x = ( ( event.clientX - rect.left ) / rect.width ) * 2 - 1
		ndc.y = -( ( event.clientY - rect.top ) / rect.height ) * 2 + 1
		raycaster.setFromCamera( ndc, camera )
		const hits = raycaster.intersectObject( scene, true )
		const hit = hits.find( ( h ) => h.object.visible && ! skipPick( h.object ) )
		if ( ! hit ) {
			refresh( dumpPoints() + ( points.length ? '\n' : '' ) + '没打到模型' )
			return
		}
		const p = hit.point.clone()
		points.push( p )
		addMarker( p )
		refresh()
		console.info( '[rainy-night] pick', points.length - 1, fmt( p.x ), fmt( p.y ), fmt( p.z ), hit.object.name )
	}

	const onCanvasClick = ( event: PointerEvent ) => {
		if ( ! picking ) return
		if ( event.button !== 0 ) return
		event.preventDefault()
		pickAt( event )
	}

	const onKey = ( event: KeyboardEvent ) => {
		if ( event.repeat || event.ctrlKey || event.metaKey || event.altKey ) return
		const tag = ( event.target as HTMLElement | null )?.tagName
		if ( tag === 'INPUT' || tag === 'TEXTAREA' ) return
		if ( event.code === 'KeyC' ) {
			event.preventDefault()
			capturePose()
		}
	}

	poseBtn.addEventListener( 'click', capturePose )
	pickBtn.addEventListener( 'click', () => setPicking( ! picking ) )
	undoBtn.addEventListener( 'click', () => {
		points.pop()
		popMarker()
		refresh()
	} )
	copyBtn.addEventListener( 'click', copyPoints )
	clearBtn.addEventListener( 'click', () => {
		points.length = 0
		clearMarkers()
		refresh( '已清空' )
	} )
	canvas.addEventListener( 'pointerdown', onCanvasClick )
	window.addEventListener( 'keydown', onKey )

	let disposed = false
	return {
		dispose() {
			if ( disposed ) return
			disposed = true
			setPicking( false )
			poseBtn.removeEventListener( 'click', capturePose )
			canvas.removeEventListener( 'pointerdown', onCanvasClick )
			window.removeEventListener( 'keydown', onKey )
			clearMarkers()
			markerGeo.dispose()
			markerMat.dispose()
			root.remove()
		},
	}
}
