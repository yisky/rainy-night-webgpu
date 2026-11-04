/**
 * 碰撞高度图：正交俯视把场景世界坐标烘焙进 Float 渲染目标。
 *
 * 雨滴要砸到石阶 / 屋顶再溅花，不能只靠固定 y=0。
 * 隔帧用正交相机自上而下渲染；overrideMaterial 把 positionWorld 写入 RGBA，
 * 采样 .y 即世界高度。中心 xz 跟随主相机，避免走出烘焙范围后雨全掉穿。
 * 相机 xz 未动则跳过重烤：高度场只跟窗口中心有关，停机位时画面不变。
 * 渲高度前应把雨根等隐藏，避免雨丝自己写进高度。
 */

import {
	FloatType,
	MeshBasicNodeMaterial,
	NearestFilter,
	OrthographicCamera,
	RenderTarget,
	Vector3,
	type Camera,
	type Object3D,
	type Scene,
	type WebGPURenderer,
} from 'three/webgpu'
import { float, positionWorld, uniform, vec2, vec4 } from 'three/tsl'

/** 高度图默认覆盖范围与分辨率。 */
export const HEIGHT_MAP_DEFAULTS = {
	/** 略大于雨区，边缘采样不易落到 RT 外得到假 y=0。 */
	width: 140,
	height: 140,
	depth: 120,
	resolution: 512,
	cameraHeight: 60,
	/** 2 = 隔帧烤；xz 未动仍会先跳过，走动时雨落点最多偏几厘米。 */
	frameSkip: 2,
} as const

/**
 * {@link createHeightMap} 的可选参数。
 */
export interface HeightMapOptions {
	scene: Scene
	renderer: WebGPURenderer
	width?: number
	height?: number
	depth?: number
	resolution?: number
	cameraHeight?: number
	frameSkip?: number
}

/**
 * 每帧更新高度图时传入的参数。
 */
export interface HeightMapUpdateArgs {
	camera: Camera
	/** 渲染高度图时临时隐藏（雨根等），避免自己写入高度。 */
	hideObjects?: Array<Object3D | null | undefined>
}

/**
 * 高度图句柄：供雨系统采样 UV / 纹理，并在主循环里 update。
 */
export interface HeightMapHandle {
	/** 正交高度相机（调试俯视可用）。 */
	camera: OrthographicCamera
	renderTarget: RenderTarget
	/** 高度图中心 xz 跟随主相机；y 固定为 cameraHeight。 */
	position: Vector3
	/**
	 * TSL：世界坐标 → 高度图 UV。
	 * 暴露成节点函数，是为了让 compute 与材质共用同一套映射。
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getUV: ( worldPos: any ) => any
	update: ( args: HeightMapUpdateArgs ) => void
	dispose: () => void
}

/**
 * 创建正交俯视 Float 高度图。
 *
 * 原理：MeshBasicNodeMaterial.outputNode = vec4(positionWorld, 1)，自上而下正交渲染进
 * Float RT；Nearest 过滤保住屋檐边缘，线性会抹平落点。position 与 uniform 共享同一
 * Vector3 引用，每帧 set 后 GPU 侧自动读到新中心。
 *
 * 性能：相机 xz 未变则跳过；分辨率 512、范围约 140×140 是精度与带宽折中。
 * 边界：不写雨丝；不改城网格；不做河道高度特判。
 *
 * @param options - 场景、渲染器与覆盖范围。
 * @returns 高度图句柄。
 */
export function createHeightMap( options: HeightMapOptions ): HeightMapHandle {
	const {
		scene,
		renderer,
		width = HEIGHT_MAP_DEFAULTS.width,
		height = HEIGHT_MAP_DEFAULTS.height,
		depth = HEIGHT_MAP_DEFAULTS.depth,
		resolution = HEIGHT_MAP_DEFAULTS.resolution,
		cameraHeight = HEIGHT_MAP_DEFAULTS.cameraHeight,
		frameSkip = HEIGHT_MAP_DEFAULTS.frameSkip,
	} = options

	const halfW = width / 2
	const halfH = height / 2

	const heightCamera = new OrthographicCamera( -halfW, halfW, halfH, -halfH, 0.1, depth )

	const renderTarget = new RenderTarget( resolution, resolution, { type: FloatType } )
	// Nearest：高度是标量场，线性插值会抹平屋檐，溅水会「漂」。
	renderTarget.texture.magFilter = NearestFilter
	renderTarget.texture.minFilter = NearestFilter
	renderTarget.texture.generateMipmaps = false

	const material = new MeshBasicNodeMaterial()
	material.outputNode = vec4( positionWorld, 1 )

	const position = new Vector3()
	const positionUniform = uniform( position )

	let frameCounter = 0
	const skip = Math.max( 1, frameSkip )
	let lastBakeX = Number.NaN
	let lastBakeZ = Number.NaN
	/** 约 1/3 高度纹素（140/512）；小于此位移不重烤，雨碰撞无可见差。 */
	const SKIP_XZ_EPS = 0.08
	const SKIP_XZ_EPS_SQ = SKIP_XZ_EPS * SKIP_XZ_EPS

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const getUV = ( worldPos: any ): any => {
		const halfWidthN = float( width / 2 )
		const halfHeightN = float( height / 2 )
		const u = worldPos.x.sub( positionUniform.x ).add( halfWidthN ).div( float( width ) )
		const v = worldPos.z.sub( positionUniform.z ).add( halfHeightN ).div( float( height ) )
		return vec2( u, v )
	}

	const update = ( { camera, hideObjects = [] }: HeightMapUpdateArgs ): void => {
		frameCounter += 1
		if ( frameCounter % skip !== 0 ) return

		const camX = camera.position.x
		const camZ = camera.position.z
		if (
			Number.isFinite( lastBakeX ) &&
			( camX - lastBakeX ) * ( camX - lastBakeX ) + ( camZ - lastBakeZ ) * ( camZ - lastBakeZ ) < SKIP_XZ_EPS_SQ
		) {

			return

		}
		lastBakeX = camX
		lastBakeZ = camZ

		position.set( camX, cameraHeight, camZ )
		heightCamera.position.set( position.x, position.y, position.z )
		heightCamera.lookAt( position.x, 0, position.z )
		heightCamera.updateMatrixWorld( true )

		const hidden = hideObjects
			.filter( ( obj ): obj is Object3D => !!obj )
			.map( ( object ) => ( { object, visible: object.visible } ) )
		for ( const { object } of hidden ) {
			object.visible = false
		}

		const prevTarget = renderer.getRenderTarget()
		const prevMrt = renderer.getMRT()
		const prevOverride = scene.overrideMaterial

		scene.overrideMaterial = material
		renderer.setMRT( null )
		renderer.setRenderTarget( renderTarget )
		renderer.render( scene, heightCamera )
		renderer.setMRT( prevMrt )
		renderer.setRenderTarget( prevTarget )
		scene.overrideMaterial = prevOverride

		for ( const { object, visible } of hidden ) {
			object.visible = visible
		}
	}

	const dispose = (): void => {
		renderTarget.dispose()
		material.dispose()
	}

	return {
		camera: heightCamera,
		renderTarget,
		position,
		getUV,
		update,
		dispose,
	}
}
