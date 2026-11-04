/**
 * 雨夜后处理管线：场景 pass → 雨层相加 → 泛光 → 高度雾 → 闪电 → 色调映射 → 抖动。
 *
 * 串序：beauty = color + rain → bloom → SSF 雾 → 闪电 pass
 * → `renderOutput`(ACES + sRGB) → Dither。
 * 积水倒影由 createPlanarPuddleReflect 烤 RT，经 ReflectOverlay 叠回；干路不采平面倒影。
 * 雨丝/水花另开无 MRT 的 pass（Additive 粒子），与场景 pass 共用深度后再叠回。
 * 成色只写 SSF uniform，不写 `scene.background`；背景色由夜空底光模块负责。
 * 雾色与天穹地平、清屏同一套冷青灰，用来把小岛城边化进雨雾。
 */

import {
	ACESFilmicToneMapping,
	Color,
	DepthTexture,
	Layers,
	RenderPipeline,
	SRGBColorSpace,
	Vector2,
	Vector3,
	type Camera,
	type Scene,
	type WebGPURenderer,
} from 'three/webgpu'
import {
	add,
	float,
	mul,
	pass,
	renderOutput,
	uniform,
} from 'three/tsl'
import { SceneBloom } from './bloom/Bloom'
import { Dither } from './dither/Dither'
import { SSF } from './ssf/SSF'
import { LIGHTNING_LAYER } from '../lightning/createLightning'
import { RAIN_LAYER } from '../rain/createRain'

/**
 * 雨夜 SSF 默认参数（相对模组高度标定，非通川拂晓默认）。
 */
export const RAINY_SSF_FOG_DEFAULTS = {
	/** 开启高度雾 */
	enabled: true,
	/** 与天穹地平、清屏同一套冷青灰，把城边吃进雾里 */
	fogColor: '#1e2a38',
	/** 远景几乎化进雾，藏住 48 单位小岛的硬边 */
	fogMaxOpacity: 0.82,
	/** 略加密；近处仍靠 fogStartDistance 保住灯笼 */
	fogDensity: 0.14,
	/** 雾层顶面世界 Y，略抬以盖住远墙 */
	fogHeight: 10,
	/** 高度衰减放缓，雾更厚、更包一圈 */
	fogHeightFalloff: 0.16,
	/** 巷内约 10 米内几乎不起雾 */
	fogStartDistance: 10,
	/** 噪声起伏略抬，破匀雾感 */
	noiseStrength: 1.6,
	noiseScale: 0.035,
	noiseSpeedX: 0.18,
	noiseSpeedZ: 0.06,
	/** 散射跟雾色同一族，压低免得把地平洗亮 */
	inscatteringColor: '#243446',
	inscatteringIntensity: 0.32,
	inscatteringExponent: 4,
	inscatteringStart: 18,
	/** 散射方向：偏南偏东 */
	azimuthDeg: 20,
	elevationDeg: 55,
} as const

/**
 * 雨夜泛光默认强度。略高于参照仓 `0.05`，让远处小灯还能晕一层。
 * 近处窗/灯笼过曝时可收到 0.05。
 */
export const RAINY_BLOOM_STRENGTH = 0.07

/**
 * {@link createPostPipeline} 选项。
 */
export interface PostPipelineOptions {
	renderer: WebGPURenderer
	scene: Scene
	camera: Camera
}

/**
 * 管线句柄：用 `render` 驱动；可达 `fog` / `bloom` 做运行时调参。
 */
export interface PostPipelineHandle {
	/** 链上的高度雾节点（可再被外层 TempNode 包） */
	fog: SSF
	/** Jimenez 式多级泛光；`bloom.bloom.value` 为强度 */
	bloom: SceneBloom
	/** 场景成色 / 深度通 */
	scenePass: ReturnType<typeof pass>
	/** 雨丝/水花单独 pass（与场景 pass 共用深度） */
	rainPass: ReturnType<typeof pass>
	/** 唯一 RenderPipeline */
	pipeline: RenderPipeline
	/** 闪电单独 pass（与场景 pass 共用深度，叠在雾后） */
	lightningPass: ReturnType<typeof pass>
	/** ±1/255 显示抖动，接在 renderOutput 之后。 */
	dither: Dither
	/**
	 * 闪电片闪（0～1）。乘在雾色上，折线本身由 lightningPass 相加。
	 *
	 * @param amount - 0 为无，1 为约 10% 提亮。
	 */
	setLightningFill: ( amount: number ) => void
	/** 每帧调用（含 TempNode 的 updateBefore 自动跑） */
	render: () => void
	/** 换画布时改 pass 尺寸 */
	resize: ( width?: number, height?: number ) => void
	/** 拆雾 / 泛光 → pass → pipeline */
	dispose: () => void
}

/**
 * 方位角 / 仰角 → 入射光方向（数学 0 为北平面，Y 负为光从上方来）。
 */
function lightDirectionFromAzEl( azimuthDeg: number, elevationDeg: number ): Vector3 {

	const az = ( azimuthDeg * Math.PI ) / 180
	const el = ( elevationDeg * Math.PI ) / 180
	const horizontal = Math.cos( el )
	return new Vector3(
		Math.sin( az ) * horizontal,
		-Math.sin( el ),
		Math.cos( az ) * horizontal,
	)

}

/**
 * Additive pass 清成黑底再画；叠回时黑底 +0。
 */
function bindAdditiveBlackClear( passNode: ReturnType<typeof pass> ): void {

	const inner = passNode.updateBefore.bind( passNode )
	passNode.updateBefore = ( frame ): boolean | undefined => {

		const r = frame.renderer
		if ( ! r ) {

			return inner( frame ) as boolean | undefined

		}
		const prevColor = new Color()
		r.getClearColor( prevColor )
		const prevAlpha = r.getClearAlpha()
		r.setClearColor( 0x000000, 0 )
		const result = inner( frame )
		r.setClearColor( prevColor, prevAlpha )
		return result as boolean | undefined

	}

}

/**
 * 搭建雨夜后处理管线：
 * `pass` → `color.add(rain)` → `SceneBloom` → `SSF` → 闪电 → `renderOutput` → Dither。
 *
 * @param options - 渲染器 / 场景 / 相机
 */
export function createPostPipeline( options: PostPipelineOptions ): PostPipelineHandle {

	const { renderer, scene, camera } = options
	const d = RAINY_SSF_FOG_DEFAULTS

	// 关掉场景雾；成色不在这里写，由夜景与雾色走 background
	scene.fog = null

	const scenePass = pass( scene, camera, { samples: 0 } )
	scenePass.transparent = true
	scenePass.opaque = true
	// 雨丝/水花是 Additive 粒子；与场景同 pass 时易把图集黑底写成黑方块。
	// 场景 pass 去掉雨层，雨另开 pass，共用深度后再相加叠回。
	const sceneLayers = new Layers()
	sceneLayers.enableAll()
	sceneLayers.disable( RAIN_LAYER )
	sceneLayers.disable( LIGHTNING_LAYER )
	scenePass.setLayers( sceneLayers )

	// 单附件成色（不设 MRT；屏空间反射已移除，无需法线/金属粗糙附件）

	// 雨层单独 pass：Additive 混合；深度复用场景 pass，遮挡仍正确
	const rainLayers = new Layers()
	rainLayers.disableAll()
	rainLayers.enable( RAIN_LAYER )
	const rainPass = pass( scene, camera, {
		samples: 0,
		depthTexture: scenePass.getTexture( 'depth' ) as DepthTexture,
	} )
	rainPass.opaque = false
	rainPass.transparent = true
	rainPass.autoClearDepth = false
	rainPass.autoClearColor = true
	rainPass.setLayers( rainLayers )
	bindAdditiveBlackClear( rainPass )

	const lightningLayers = new Layers()
	lightningLayers.disableAll()
	lightningLayers.enable( LIGHTNING_LAYER )
	const lightningPass = pass( scene, camera, {
		samples: 0,
		depthTexture: scenePass.getTexture( 'depth' ) as DepthTexture,
	} )
	lightningPass.opaque = false
	lightningPass.transparent = true
	lightningPass.autoClearDepth = false
	lightningPass.autoClearColor = true
	lightningPass.setLayers( lightningLayers )
	bindAdditiveBlackClear( lightningPass )

	const rainColor = rainPass.getTextureNode( 'output' )

	const color = scenePass.getTextureNode( 'output' )
	const depth = scenePass.getTextureNode( 'depth' )

	// beauty = 场景色 + 雨层；bloom→SSF 链路。
	const beauty = color.add( rainColor )

	// 泛光：SceneBloom 首级要对 TextureNode 做纹素邻域采样（Karis），
	// 不能直接吃 color.add(...) 运算节点；故仍从场景色抽高光。
	// 成片串序仍是 beauty.add(bloom)→雾：灯笼本体照常泛光。
	const bloom = new SceneBloom( color )
	bloom.bloom.value = RAINY_BLOOM_STRENGTH

	// 雾吃「场景色+雨+泛光」，光晕进高度雾衰减
	const fog = new SSF( {
		color: beauty.add( bloom as never ),
		depth,
		camera,
		enabled: d.enabled,
		fogColor: d.fogColor,
		fogMaxOpacity: d.fogMaxOpacity,
		fogDensity: d.fogDensity,
		fogHeight: d.fogHeight,
		fogHeightFalloff: d.fogHeightFalloff,
		fogStartDistance: d.fogStartDistance,
		noiseStrength: d.noiseStrength,
		noiseScale: d.noiseScale,
		noiseSpeed: new Vector2( d.noiseSpeedX, d.noiseSpeedZ ),
		inscatteringLightDirection: lightDirectionFromAzEl( d.azimuthDeg, d.elevationDeg ),
		directionalInscatteringColor: new Color( d.inscatteringColor ).multiplyScalar( d.inscatteringIntensity ),
		directionalInscatteringExponent: d.inscatteringExponent,
		directionalInscatteringStartDistance: d.inscatteringStart,
	} )

	const uLightningFill = uniform( 0 )
	const lightningColor = lightningPass.getTextureNode( 'output' )
	const pipeline = new RenderPipeline( renderer )
	// 关掉管线自带输出变换，改由 renderOutput 显式做 ACES+sRGB，再接抖动。
	// 渲染器保持 NoToneMapping，倒影烤图才不会被压两遍。
	pipeline.outputColorTransform = false
	// SSF 类上没有 TSL 链式方法；折线加在雾后，才不会被远景深度洗淡。
	const graded = add(
		mul( fog as never, float( 1 ).add( uLightningFill.mul( 0.5 ) ) ),
		lightningColor,
	)
	const mapped = renderOutput( graded, ACESFilmicToneMapping, SRGBColorSpace )
	const dither = new Dither( { input: mapped } )
	pipeline.outputNode = dither

	const resize = ( width?: number, height?: number ) => {

		const w = Math.max( 1, width ?? renderer.domElement.width )
		const h = Math.max( 1, height ?? renderer.domElement.height )
		scenePass.setSize( w, h )
		rainPass.setSize( w, h )
		lightningPass.setSize( w, h )

	}

	return {
		fog,
		bloom,
		scenePass,
		rainPass,
		lightningPass,
		dither,
		pipeline,
		setLightningFill: ( amount: number ) => {

			uLightningFill.value = Math.max( 0, Math.min( 1, amount ) )

		},
		render: () => {

			pipeline.render()

		},
		resize,
		dispose: () => {

			fog.dispose()
			bloom.dispose()
			lightningPass.dispose()
			rainPass.dispose()
			scenePass.dispose()
			pipeline.dispose()

		},
	}

}