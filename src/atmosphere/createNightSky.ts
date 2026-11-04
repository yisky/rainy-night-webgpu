/**
 * 夜空穹顶（threejspunk `createNightSky` 原样迁入）。
 *
 * 半径 135、Y 偏移 -33.5。噪声用 custom_noise / custom_perlin（数值与贴图均照搬，勿改色/强度）。
 * 独立图层：高度图不要采到它；主相机开启同图层可见。
 *
 * 对照：`D:\工作\仓库\threejspunk\src\systems\atmosphere\createNightSky.ts`
 * 贴图：`/textures/custom_noise.webp`、`/textures/custom_perlin.webp`（自 punk reference-assets 拷入）。
 */

import {
	BackSide,
	Mesh,
	MeshBasicNodeMaterial,
	RepeatWrapping,
	SphereGeometry,
	SRGBColorSpace,
	TextureLoader,
	type Camera,
	type Scene,
	type Texture,
	type WebGPURenderer,
} from 'three/webgpu'
import {
	color,
	float,
	mix,
	positionWorld,
	smoothstep,
	texture,
	uv,
	vec2,
} from 'three/tsl'

/**
 * 天空图层；主相机开启，高度图相机保持默认第 0 层故采不到天穹。
 * 与 threejspunk `SKY_LAYER` 同值。
 */
export const SKY_LAYER = 4

/** 天穹半径（世界单位）。与 punk 一致，勿改。 */
const SKY_RADIUS = 135

/** 天穹整体下移。与 punk 一致，勿改。 */
const SKY_Y = -33.5

/** 天顶色，比地平更暗，保持夜空层次。 */
const SKY_TOP = 0x0a1018

/** 近地平线色，与 SSF 雾色 #1e2a38 对齐。 */
const SKY_BOTTOM = 0x1e2a38

/**
 * 夜空噪声贴图 URL（雨夜 `public/textures`，内容同 punk reference-assets）。
 */
const SKY_TEXTURES = {
	customNoise: '/textures/custom_noise.webp',
	customPerlin: '/textures/custom_perlin.webp',
} as const

/**
 * {@link createNightSky} 返回的句柄。
 */
export interface NightSkyHandle {
	/** 已加入场景的内翻天穹网格。 */
	mesh: Mesh
	/** 释放几何/材质/贴图并从场景移除。 */
	dispose: () => void
}

/**
 * {@link createNightSky} 入参（须 WebGPU 渲染器与主相机，以便 initTexture / 开图层）。
 */
export interface NightSkyOptions {
	scene: Scene
	renderer: WebGPURenderer
	camera: Camera
}

/**
 * 用 TextureLoader 拉取一张贴图。
 *
 * @param url - 公共路径。
 */
function loadTexture( url: string ): Promise<Texture> {
	return new Promise( ( resolve, reject ) => {
		new TextureLoader().load( url, resolve, undefined, reject )
	} )
}

/**
 * 创建阴雨夜空穹顶：内翻球 + 高度染色 + 噪声云斑（punk 原样参数）。
 *
 * @param options - 场景 / WebGPU 渲染器 / 主相机。
 * @returns 含 mesh 与 dispose 的句柄。
 */
export async function createNightSky( options: NightSkyOptions ): Promise<NightSkyHandle> {
	const { scene, renderer, camera } = options

	const [ noise, perlin ] = await Promise.all( [
		loadTexture( SKY_TEXTURES.customNoise ),
		loadTexture( SKY_TEXTURES.customPerlin ),
	] )
	for ( const map of [ noise, perlin ] ) {
		map.colorSpace = SRGBColorSpace
		map.wrapS = RepeatWrapping
		map.wrapT = RepeatWrapping
		renderer.initTexture( map )
	}

	const grain = texture( noise, uv().mul( vec2( 6, 3 ) ) ).r
	const cloud = texture( perlin, uv().mul( vec2( 2.4, 1.2 ) ) ).r
	const height = smoothstep( float( -20 ), float( 70 ), positionWorld.y )
	const tint = mix( color( SKY_BOTTOM ), color( SKY_TOP ), height )
	const weather = float( 1 )
		.sub( cloud.mul( 0.22 ) )
		.add( grain.sub( 0.5 ).mul( 0.08 ) )

	const material = new MeshBasicNodeMaterial()
	material.side = BackSide
	material.depthWrite = false
	material.depthTest = false
	material.fog = false
	material.toneMapped = false
	material.colorNode = tint.mul( weather )

	const mesh = new Mesh( new SphereGeometry( SKY_RADIUS, 48, 32 ), material )
	mesh.name = 'night-sky'
	mesh.position.y = SKY_Y
	mesh.frustumCulled = false
	mesh.renderOrder = -20
	mesh.castShadow = false
	mesh.receiveShadow = false
	mesh.layers.disable( 0 )
	mesh.layers.enable( SKY_LAYER )
	camera.layers.enable( SKY_LAYER )
	scene.add( mesh )

	return {
		mesh,
		dispose: () => {
			mesh.removeFromParent()
			mesh.geometry.dispose()
			material.dispose()
			noise.dispose()
			perlin.dispose()
		},
	}
}
