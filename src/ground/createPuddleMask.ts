/**
 * 积水门控：法线凹度 + 粗糙度辅，给湿膜涟漪和塘底填亮用。
 *
 * 仓内无独立 height / displacement 贴图，用 wet-puddles-normal 切线空间法线做有限差分，
 * 估计高度场拉普拉斯（n.xy ≈ ∇h，∇·n.xy ≈ ∇²h）。凹度 softstep 后出口取反 → 积水亮。
 * 辅以 roughness 暗区弱加权；极弱世界 xz 噪声只破边缘。
 * 倒影水洼分布另走噪声主导（见 ROAD_BRIDGE_WET_DEFAULTS.noiseWeight），不与本 mask 强行合一。
 * gate = outside + mask*(1-outside)；outside=0 时非积水灭环。
 */

import {
	Fn,
	clamp,
	float,
	floor,
	fract,
	mix,
	smoothstep,
	texture,
	vec2,
} from 'three/tsl'
import type { Texture } from 'three/webgpu'

import { hashD9 } from './createRipples'

/** 积水门控可调默认值（路桥湿膜涟漪 / 塘底用）。 */
export const PUDDLE_MASK_DEFAULTS = {
	/**
	 * 法线 UV 有限差分步长（相对 tiled UV）。
	 * 约贴图 1/250 像素尺度，过大抹平凹谷、过小噪点多。
	 */
	concavityEps: 0.004,
	/**
	 * 拉普拉斯放大：把邻域差分拉到大约可调的 [0,1] 区间。
	 */
	concavityGain: 10,
	/**
	 * 粗糙度暗区辅助权重 0～1。
	 * 越低越少被糙图压塘。沥青弱环：默认 0.25。
	 */
	roughnessAssist: 0.25,
	/**
	 * 极弱噪声调制幅度。0=关；只乘在凹度分上破边缘，主控仍是凹凸。
	 */
	noiseMod: 0.10,
	/**
	 * 噪声调制用的世界 xz 频率（仅 noiseMod>0 时有意义）。
	 */
	puddleScale: 0.10,
	/**
	 * softstep 低阈；越低塘区越扩。沥青弱环：默认 0.42。
	 */
	puddleThreshold: 0.42,
	/**
	 * 边缘 softstep 宽度。
	 */
	puddleSoftness: 0.12,
	/**
	 * 非积水区涟漪残留。沥青全区弱环：默认 0（仅塘内有环）（塘内仍≈1）。
	 * gate = outside + mask*(1-outside)。
	 */
	puddleOutsideRipple: 0,
} as const

/**
 * {@link createPuddleMaskNode} 所需 uniforms / 贴图 / UV。
 */
export interface CreatePuddleMaskNodeOptions {
	/** wet-puddles-normal（或同 UV 套法线）。 */
	normalMap: Texture
	/** wet-puddles-roughness（暗=更湿，作弱辅）。 */
	roughnessMap: Texture
	/** 未加涟漪偏移的 tiled UV（mask 不随环游走）。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	baseUv: any
	/** 世界 xz，仅供极弱噪声调制。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	worldXZ: any
	/** 有限差分步长。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uConcavityEps: any
	/** 凹度增益。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uConcavityGain: any
	/** 粗糙度辅助权重。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uRoughnessAssist: any
	/** 噪声调制幅度。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uNoiseMod: any
	/** 噪声世界 xz 频率。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uPuddleScale: any
	/** softstep 低阈。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uPuddleThreshold: any
	/** softstep 宽度。 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uPuddleSoftness: any
}

/**
 * 二维值噪声（给噪声调制用；与 createRipples 同源 hashD9）。
 * 输入任意 xz，输出约 [0,1)。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const valueNoise2D = Fn( ( [ p ]: [ any ] ) => {
	const i = floor( p )
	const f = fract( p )
	// Hermite：f*f*(3-2f)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const u: any = f.mul( f ).mul( float( 3 ).sub( f.mul( 2 ) ) )
	const a = hashD9( i )
	const b = hashD9( i.add( vec2( 1, 0 ) ) )
	const c = hashD9( i.add( vec2( 0, 1 ) ) )
	const d = hashD9( i.add( vec2( 1, 1 ) ) )
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y )
} )

/**
 * 由法线凹度生成积水 mask 节点（float [0,1]）。
 *
 * 原理：切线法线 n.xy 近似高度梯度；对邻域做有限差分得散度 ≈ 拉普拉斯。
 * 凹度打分后 softstep，再 1-raw 取反 → 积水。再乘 mix(1, 1-roughness, assist)，
 * 可选乘极弱噪声。最后 softstep 成稀疏塘斑。
 *
 * @param options - 贴图、baseUv、uniforms
 * @returns float 节点，塘内近 1、塘外近 0
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPuddleMaskNode( options: CreatePuddleMaskNodeOptions ): any {
	const {
		normalMap,
		roughnessMap,
		baseUv,
		worldXZ,
		uConcavityEps,
		uConcavityGain,
		uRoughnessAssist,
		uNoiseMod,
		uPuddleScale,
		uPuddleThreshold,
		uPuddleSoftness,
	} = options

	const epsX = vec2( uConcavityEps, float( 0 ) )
	const epsY = vec2( float( 0 ), uConcavityEps )

	// 解包到 [-1,1]；只用 xy 当 ∇h
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const unpackXY = ( sample: any ) => sample.xy.mul( 2 ).sub( 1 )

	const nL = unpackXY( texture( normalMap, baseUv.sub( epsX ) ) )
	const nR = unpackXY( texture( normalMap, baseUv.add( epsX ) ) )
	const nD = unpackXY( texture( normalMap, baseUv.sub( epsY ) ) )
	const nU = unpackXY( texture( normalMap, baseUv.add( epsY ) ) )

	// ∇²h ≈ ∂nx/∂x + ∂ny/∂y（略去 /2ε，并入 gain）
	const laplacian = nR.x.sub( nL.x ).add( nU.y.sub( nD.y ) ).mul( uConcavityGain )
	const concavity = clamp( laplacian, float( 0 ), float( 1 ) )

	const rough = texture( roughnessMap, baseUv ).r
	const wetAssist = float( 1 ).sub( rough )
	// 主控仍是凹度；粗糙度暗区作加法弱辅（不单独满铺），干/糙处略压凹度
	const scored = clamp(
		concavity.mul( mix( float( 1 ), wetAssist.add( 0.35 ).min( float( 1 ) ), uRoughnessAssist.mul( 0.5 ) ) )
			.add( wetAssist.mul( uRoughnessAssist ).mul( 0.45 ) ),
		float( 0 ),
		float( 1 ),
	)

	const noise = valueNoise2D( worldXZ.mul( uPuddleScale ) )
	const modulated = scored.mul( mix( float( 1 ), noise, uNoiseMod ) )

	const hi = uPuddleThreshold.add( uPuddleSoftness )
	// 原 smoothstep 高值落在非积水、积水反而灭环 → 出口取反。
	// 取反后：mask 亮=积水、暗=非积水；gate=outside+mask*(1-outside) 与可视化灰阶同向。
	const raw = smoothstep( uPuddleThreshold, hi, modulated )
	return float( 1 ).sub( raw )
}

/**
 * 把 puddleMask 收成「涟漪门控」：塘外 = outsideRipple，塘内 → 1。
 * 有效涟漪偏移 = 原偏移 × gate。
 *
 * @param puddleMask - 0～1 积水节点
 * @param uOutsideRipple - 塘外残留 uniform
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function puddleRippleGate( puddleMask: any, uOutsideRipple: any ): any {
	// gate = outside + mask * (1 - outside)
	return uOutsideRipple.add( puddleMask.mul( float( 1 ).sub( uOutsideRipple ) ) )
}
