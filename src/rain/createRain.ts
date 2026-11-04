/**
 * 碰撞雨：WebGPU compute 更新落点，InstancedMesh 画雨丝与水花。
 *
 * 数千滴若用 CPU 写实例矩阵会打满主线程；改为 storage buffer + compute。
 * 雨丝是细长 billboard；水花采 `water-splash` 五帧横条图集，落在高度图采样的 y 上。
 * 雨区锚在相机前方水平朝向，随镜头 wrap，避免整片被甩出视野。
 */

import {
	AdditiveBlending,
	ClampToEdgeWrapping,
	Group,
	InstancedMesh,
	NodeMaterial,
	PlaneGeometry,
	Sphere,
	SRGBColorSpace,
	TextureLoader,
	Vector3,
	type Camera,
	type Scene,
	type Texture,
	type WebGPURenderer,
} from 'three/webgpu'
import {
	billboarding,
	color,
	Discard,
	float,
	floor,
	Fn,
	fract,
	hash,
	If,
	instanceIndex,
	instancedArray,
	mix,
	positionGeometry,
	texture,
	time,
	uint,
	uniform,
	uv,
	vec2,
} from 'three/tsl'

import type { HeightMapHandle } from './createHeightMap'

/** 雨滴所在图层；主相机需 enable 后才能看见。 */
export const RAIN_LAYER = 2

/** 雨丝 / 水花默认参数。 */
export const RAIN_DEFAULTS = {
	maxCount: 5000,
	minCount: 500,
	count: 3500,
	rainArea: { width: 100, height: 100 },
	cameraForwardOffset: 20,
	opacity: 0.15,
	intensity: 0.45,
	splashOpacity: 0.35,
	splashSpeed: 6,
	fallSpeed: 0.7,
	fallSpeedJitter: 0.07,
	splashStartScale: 0.1,
	splashEndScale: 1.4,
	splashSize: 1.2,
	dropWidth: 0.04,
	dropHeight: 1.1,
	splashPlaneSize: 0.13,
	splashFrames: 5,
	dropColor: 0xdcffff,
	splashTextureUrl: '/textures/water-splash.png',
} as const

/**
 * 运行时可调的雨参数快照（与 uniforms 同步）。
 */
export interface RainParams {
	enabled: boolean
	count: number
	opacity: number
	intensity: number
	splashOpacity: number
	splashSpeed: number
	fallSpeed: number
	splashSize: number
	splashStartScale: number
	splashEndScale: number
	rainAreaWidth: number
	rainAreaHeight: number
	cameraForwardOffset: number
}

/**
 * {@link createRain} 的构造参数。
 */
export interface RainOptions {
	scene: Scene
	renderer: WebGPURenderer
	heightMap: HeightMapHandle
	camera?: Camera | null
	count?: number
	rainArea?: { width: number; height: number }
	splashTextureUrl?: string
}

/**
 * 雨系统句柄。
 */
export interface RainHandle {
	/** 根节点；高度图 update 时应 hideObjects:[rain.root]。 */
	root: Group
	rainParticles: InstancedMesh
	splashParticles: InstancedMesh
	layer: number
	params: RainParams
	/**
	 * 每帧推进 compute。
	 * @param _dt - 签名保留；下落按帧加 velocity（未乘 dt）。
	 * @param camera - 用于把雨区锚在相机前方。
	 */
	update: ( _dt: number, camera: Camera ) => void
	/** 开关可见性与 compute。 */
	setEnabled: ( enabled: boolean ) => void
	/** 调整雨量观感强度（乘到雨丝透明度上）。 */
	setIntensity: ( intensity: number ) => void
	dispose: () => void
}

/**
 * 把滴数夹到 [minCount, maxCount]。
 *
 * @param n - 期望滴数。
 * @returns 夹紧后的整数。
 */
function clampCount( n: number ): number {
	return Math.min( Math.max( RAIN_DEFAULTS.minCount, Math.round( n ) ), RAIN_DEFAULTS.maxCount )
}

/**
 * 雨粒子只挂雨图层，避免被高度图 / 反射相机误采。
 *
 * @param obj - 带 layers 的对象。
 */
function putOnRainLayer( obj: {
	layers: { disable: ( n: number ) => void; enable: ( n: number ) => void }
} ): void {
	obj.layers.disable( 0 )
	obj.layers.enable( RAIN_LAYER )
}

/**
 * 异步加载水花条带纹理。
 *
 * @param url - 纹理 URL。
 * @returns 纹理。
 */
function loadTexture( url: string ): Promise<Texture> {
	return new Promise( ( resolve, reject ) => {
		new TextureLoader().load( url, resolve, undefined, reject )
	} )
}

/**
 * 创建碰撞雨（异步：需加载水花图集）。
 *
 * 原理：storage 存每滴位置/速度与水花位置/帧；computeFall 下落并采样高度图撞地重生；
 * computeSplash 按生命周期在雨区内重采样落点高度。雨丝用横向 billboard + 软边透明度；
 * 水花用五帧横条 + AdditiveBlending，黑底加成为 0。
 *
 * 性能：默认约 3500 实例；全部 GPU 更新。
 * 边界：不写高度图；不改灯笼点光；不做车身雨 / 开场雨玻璃。
 *
 * @param options - 场景、渲染器、高度图与可选滴数。
 * @returns 雨句柄。
 */
export async function createRain( options: RainOptions ): Promise<RainHandle> {
	const {
		scene,
		renderer,
		heightMap,
		camera = null,
		count: countOpt = RAIN_DEFAULTS.count,
		rainArea = RAIN_DEFAULTS.rainArea,
		splashTextureUrl = RAIN_DEFAULTS.splashTextureUrl,
	} = options

	const count = clampCount( countOpt )
	const halfW = rainArea.width / 2
	const halfH = rainArea.height / 2

	const params: RainParams = {
		enabled: true,
		count,
		opacity: RAIN_DEFAULTS.opacity,
		intensity: RAIN_DEFAULTS.intensity,
		splashOpacity: RAIN_DEFAULTS.splashOpacity,
		splashSpeed: RAIN_DEFAULTS.splashSpeed,
		fallSpeed: RAIN_DEFAULTS.fallSpeed,
		splashSize: RAIN_DEFAULTS.splashSize,
		splashStartScale: RAIN_DEFAULTS.splashStartScale,
		splashEndScale: RAIN_DEFAULTS.splashEndScale,
		rainAreaWidth: rainArea.width,
		rainAreaHeight: rainArea.height,
		cameraForwardOffset: RAIN_DEFAULTS.cameraForwardOffset,
	}

	const root = new Group()
	root.name = 'CollisionRain'
	scene.add( root )

	const cameraPosU = uniform( new Vector3() )
	const cameraForwardU = uniform( new Vector3() )
	const opacityU = uniform( params.opacity )
	const intensityU = uniform( params.intensity )
	const splashOpacityU = uniform( params.splashOpacity )
	const splashSpeedU = uniform( params.splashSpeed )
	const fallSpeedU = uniform( params.fallSpeed )
	const fallJitterU = uniform( RAIN_DEFAULTS.fallSpeedJitter )
	const splashSizeU = uniform( params.splashSize )
	const splashStartScaleU = uniform( params.splashStartScale )
	const splashEndScaleU = uniform( params.splashEndScale )
	const areaWidthU = uniform( params.rainAreaWidth )
	const areaHeightU = uniform( params.rainAreaHeight )
	const halfWidthU = uniform( halfW )
	const halfHeightU = uniform( halfH )
	const forwardOffsetU = uniform( params.cameraForwardOffset )

	const dropPosition = instancedArray( count, 'vec3' )
	const dropVelocity = instancedArray( count, 'vec3' )
	const splashPosition = instancedArray( count, 'vec3' )
	const splashFrame = instancedArray( count, 'uint' )

	const randSeed = () => uint( Math.random() * 16777215 )

	const computeInit = Fn( () => {
		const pos = dropPosition.element( instanceIndex )
		const vel = dropVelocity.element( instanceIndex )
		const hx = hash( instanceIndex )
		const hy = hash( instanceIndex.add( randSeed() ) )
		const hz = hash( instanceIndex.add( randSeed() ) )
		const anchor = cameraPosU.add( cameraForwardU.mul( forwardOffsetU ) )

		pos.x = hx.mul( areaWidthU ).sub( halfWidthU ).add( anchor.x )
		pos.z = hz.mul( areaHeightU ).sub( halfHeightU ).add( anchor.z )
		pos.y = hy.mul( 25 )
		vel.y = hx.mul( fallJitterU ).sub( fallJitterU.mul( 0.5 ) ).sub( fallSpeedU )
	} )().compute( count )

	const computeFall = Fn( () => {
		const pos = dropPosition.element( instanceIndex )
		const vel = dropVelocity.element( instanceIndex )
		pos.addAssign( vel )

		const anchor = cameraPosU.add( cameraForwardU.mul( forwardOffsetU ) )
		const dx = pos.x.sub( anchor.x )
		const dz = pos.z.sub( anchor.z )

		const wrappedX = fract( dx.add( halfWidthU ).div( areaWidthU ) )
			.mul( areaWidthU )
			.sub( halfWidthU )
		pos.x = anchor.x.add( wrappedX )
		const wrappedZ = fract( dz.add( halfHeightU ).div( areaHeightU ) )
			.mul( areaHeightU )
			.sub( halfHeightU )
		pos.z = anchor.z.add( wrappedZ )

		const heightUv = heightMap.getUV( pos )
		const groundY = texture( heightMap.renderTarget.texture, heightUv ).y.add( float( 0.05 ) )

		If( pos.y.lessThan( groundY ), () => {
			const seed = float( instanceIndex ).add( time.mul( 1000 ) )
			pos.y = hash( seed.add( 77.7 ) ).mul( 15 ).add( 20 )
			pos.x = hash( seed.add( 11.1 ) ).mul( areaWidthU ).sub( halfWidthU ).add( anchor.x )
			pos.z = hash( seed.add( 44.4 ) ).mul( areaHeightU ).sub( halfHeightU ).add( anchor.z )
			vel.y = hash( seed.add( 99.9 ) )
				.mul( fallJitterU )
				.sub( fallJitterU.mul( 0.5 ) )
				.sub( fallSpeedU )
		} )
	} )().compute( count )

	const computeSplash = Fn( () => {
		const pos = splashPosition.element( instanceIndex )
		const frame = splashFrame.element( instanceIndex )
		const anchor = cameraPosU.add( cameraForwardU.mul( forwardOffsetU ) )
		const phase = hash( instanceIndex ).mul( 6.28 )
		const frameNow = floor( time.mul( splashSpeedU ).add( phase ) ).toUint()

		If( frameNow.notEqual( frame ), () => {
			frame.assign( frameNow )
			const seed = instanceIndex.add( frameNow.mul( uint( 196613 ) ) )
			const hx = hash( seed )
			const hz = hash( seed.add( uint( 77777 ) ) )
			const lx = hx.mul( areaWidthU ).sub( halfWidthU )
			const lz = hz.mul( areaHeightU ).sub( halfHeightU )
			pos.x = anchor.x.add( lx )
			pos.z = anchor.z.add( lz )
			const heightUv = heightMap.getUV( pos )
			const groundY = texture( heightMap.renderTarget.texture, heightUv ).y
			pos.y = groundY.add( 0.06 )
		} )

		const dx = pos.x.sub( anchor.x )
		const dz = pos.z.sub( anchor.z )
		const wrappedX = fract( dx.add( halfWidthU ).div( areaWidthU ) )
			.mul( areaWidthU )
			.sub( halfWidthU )
		const newX = anchor.x.add( wrappedX )
		const wrappedZ = fract( dz.add( halfHeightU ).div( areaHeightU ) )
			.mul( areaHeightU )
			.sub( halfHeightU )
		const newZ = anchor.z.add( wrappedZ )

		If( newX.notEqual( pos.x ).or( newZ.notEqual( pos.z ) ), () => {
			pos.x = newX
			pos.z = newZ
			const heightUv = heightMap.getUV( pos )
			const groundY = texture( heightMap.renderTarget.texture, heightUv ).y
			pos.y = groundY.add( 0.06 )
		} )
	} )().compute( count )

	const forwardScratch = new Vector3()
	const syncCameraUniforms = ( cam: Camera ): void => {
		cameraPosU.value.copy( cam.position )
		cam.getWorldDirection( forwardScratch )
		forwardScratch.y = 0
		if ( forwardScratch.lengthSq() > 0 ) forwardScratch.normalize()
		cameraForwardU.value.copy( forwardScratch )
		cameraPosU.needsUpdate = true
		cameraForwardU.needsUpdate = true
	}

	if ( camera ) {
		syncCameraUniforms( camera )
		camera.layers.enable( RAIN_LAYER )
	}

	await renderer.computeAsync( computeInit )
	await renderer.computeAsync( computeFall )
	await renderer.computeAsync( computeSplash )

	const splashMap = await loadTexture( splashTextureUrl )
	splashMap.colorSpace = SRGBColorSpace
	splashMap.wrapS = ClampToEdgeWrapping
	splashMap.wrapT = ClampToEdgeWrapping
	splashMap.generateMipmaps = false
	splashMap.needsUpdate = true
	renderer.initTexture( splashMap )

	const dropUv = uv()
	const softX = dropUv.x.sub( 0.5 ).abs().mul( 2 ).oneMinus().pow( 2 )
	const softY = dropUv.y
		.smoothstep( 0, 0.08 )
		.mul( dropUv.y.oneMinus().smoothstep( 0, 0.15 ) )
	const dropShape = softX.mul( softY )

	// 雨丝软边；MRT 下副附件 NoBlending，须在 colorNode 图内 Discard，否则整片盖黑
	const dropOpacity = dropShape.mul( opacityU ).mul( intensityU )
	const dropColorNode = Fn( () => {

		If( dropOpacity.lessThan( 0.02 ), () => {

			Discard()

		} )
		return color( RAIN_DEFAULTS.dropColor )

	} )()

	const dropMaterial = new NodeMaterial()
	dropMaterial.colorNode = dropColorNode
	dropMaterial.opacityNode = dropOpacity
	dropMaterial.positionNode = positionGeometry
	dropMaterial.vertexNode = billboarding( {
		position: dropPosition.toAttribute(),
		horizontal: true,
		horizontalRotation: true,
	} )
	dropMaterial.depthWrite = false
	dropMaterial.depthTest = true
	dropMaterial.transparent = true
	dropMaterial.toneMapped = false
	dropMaterial.alphaTest = 0.02

	const dropGeo = new PlaneGeometry( RAIN_DEFAULTS.dropWidth, RAIN_DEFAULTS.dropHeight )
	dropGeo.translate( 0, RAIN_DEFAULTS.dropHeight * 0.75, 0 )

	const rainParticles = new InstancedMesh( dropGeo, dropMaterial, count )
	rainParticles.count = count
	rainParticles.frustumCulled = false
	dropGeo.boundingSphere = new Sphere( new Vector3(), 1e5 )
	rainParticles.renderOrder = 12
	putOnRainLayer( rainParticles )
	root.add( rainParticles )

	const frameCount = RAIN_DEFAULTS.splashFrames
	const phase = hash( instanceIndex ).mul( 6.28 )
	const life = fract( time.mul( splashSpeedU ).add( phase ) )
	const lifeFrames = life.mul( float( frameCount ) )
	const frameA = floor( lifeFrames ).toFloat()
	const frameB = frameA.add( 1 ).min( float( frameCount - 1 ) )
	const frameFract = fract( lifeFrames )
	const splashUv = uv()
	const uvA = vec2(
		splashUv.x.div( float( frameCount ) ).add( frameA.div( float( frameCount ) ) ),
		splashUv.y,
	)
	const uvB = vec2(
		splashUv.x.div( float( frameCount ) ).add( frameB.div( float( frameCount ) ) ),
		splashUv.y,
	)
	const splashTex = mix( texture( splashMap, uvA ), texture( splashMap, uvB ), frameFract )

	const splashScale = hash( instanceIndex.add( uint( 12345 ) ) )
		.mul( 0.7 )
		.add( 0.3 )
		.mul( mix( splashStartScaleU, splashEndScaleU, life ) )
		.mul( splashSizeU )
	const splashFade = life.oneMinus().smoothstep( 0, 0.5 )
	const splashMask = splashTex.r.mul( splashOpacityU ).mul( splashFade )
	// 图集为白水花/黑底且无 alpha；与场景同 pass 时易把黑底写进成色，故雨层单独 pass。
	// Discard 必须挂在 colorNode 的 Fn 图内（仅设 alphaTest 在本路径未生效），黑底纹素直接丢弃。
	const splashColorNode = Fn( () => {

		If( splashMask.lessThan( 0.04 ), () => {

			Discard()

		} )
		// 乘 mask：Additive 正常时黑底贡献为 0；混合失效时只靠 Discard 保形
		return color( RAIN_DEFAULTS.dropColor ).mul( splashMask )

	} )()

	const splashMaterial = new NodeMaterial()
	splashMaterial.colorNode = splashColorNode
	splashMaterial.opacityNode = splashMask
	splashMaterial.positionNode = positionGeometry.mul( splashScale )
	splashMaterial.vertexNode = billboarding( {
		position: splashPosition.toAttribute(),
		horizontal: true,
		vertical: true,
	} )
	splashMaterial.depthWrite = false
	splashMaterial.depthTest = true
	splashMaterial.transparent = true
	splashMaterial.toneMapped = false
	splashMaterial.blending = AdditiveBlending
	splashMaterial.alphaTest = 0.04

	const splashGeo = new PlaneGeometry(
		RAIN_DEFAULTS.splashPlaneSize,
		RAIN_DEFAULTS.splashPlaneSize,
	)
	const splashParticles = new InstancedMesh( splashGeo, splashMaterial, count )
	splashParticles.count = count
	splashParticles.frustumCulled = false
	splashGeo.boundingSphere = new Sphere( new Vector3(), 1e5 )
	splashParticles.renderOrder = 11
	putOnRainLayer( splashParticles )
	root.add( splashParticles )
	root.frustumCulled = false

	const applyVisibility = (): void => {
		root.visible = params.enabled
		rainParticles.visible = params.enabled
		splashParticles.visible = params.enabled
	}

	const update = ( _dt: number, cam: Camera ): void => {
		if ( !params.enabled ) {
			root.visible = false
			return
		}
		applyVisibility()
		syncCameraUniforms( cam )
		renderer.compute( computeFall )
		renderer.compute( computeSplash )
	}

	const setEnabled = ( enabled: boolean ): void => {
		params.enabled = !!enabled
		applyVisibility()
	}

	const setIntensity = ( intensity: number ): void => {
		const v = Math.max( 0, intensity )
		params.intensity = v
		intensityU.value = v
	}

	const dispose = (): void => {
		scene.remove( root )
		dropGeo.dispose()
		dropMaterial.dispose()
		splashGeo.dispose()
		splashMaterial.dispose()
		splashMap.dispose()
	}

	applyVisibility()

	return {
		root,
		rainParticles,
		splashParticles,
		layer: RAIN_LAYER,
		params,
		update,
		setEnabled,
		setIntensity,
		dispose,
	}
}
