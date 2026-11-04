/**
 * 显示抖动。接在 Three 自带 {@link renderOutput}（ACES + sRGB）之后。
 *
 * 按像素和帧号做哈希，叠约 ±1/255，把 8bit 色带打散。
 * 不负责色调映射或色域转换。
 */

import { NodeUpdateType, TempNode, type Node, type NodeFrame } from 'three/webgpu'
import {
	Fn,
	float,
	uint,
	uniform,
	uvec2,
	vec4,
	viewportCoordinate,
} from 'three/tsl'

/**
 * {@link Dither} 入参。
 */
export interface DitherOptions {
	/** 已经过 renderOutput 的颜色（显示空间）。 */
	input: Node<'vec4'>
}

/**
 * ±1/255 抖动节点。
 */
export class Dither extends TempNode {

	/** 帧序号。哈希用它，每帧加一。 */
	private readonly frameIndex = uniform( 0, 'uint' )

	/** 已经过 renderOutput 的颜色。 */
	private readonly input: Node<'vec4'>

	/**
	 * @param options - 显示空间颜色
	 */
	constructor( options: DitherOptions ) {

		super( 'vec4' )
		this.updateBeforeType = NodeUpdateType.FRAME
		this.input = options.input

	}

	/**
	 * 在 RGB 上叠抖动，alpha 不动。
	 */
	setup(): Node {

		const color = this.input
		const frameIndex = this.frameIndex

		return Fn( () => {

			const pixel = uvec2( viewportCoordinate )
			const dither = postHash( pixel.add( uvec2( uint( 31337 ), uint( 271 ) ) ), frameIndex )
				.add( postHash( pixel.add( uvec2( uint( 1013 ), uint( 65537 ) ) ), frameIndex ) )
				.sub( 1 )
				.div( 255 )

			return vec4( color.rgb.add( dither ), color.a )

		} )()

	}

	/**
	 * 帧序号加一，抖动才不会停在原地。
	 *
	 * @param _frame - 当前节点帧
	 */
	updateBefore( _frame: NodeFrame ): boolean | undefined {

		this.frameIndex.value = ( Number( this.frameIndex.value ) + 1 ) >>> 0
		return

	}

}

/** 像素哈希，结果在 0..1。两路相减再除 255，得到约 ±1/255。 */
function postHash( pixel: Node<'uvec2'>, frame: Node<'uint'> ): Node<'float'> {

	const x = pixel.x.mul( uint( 1664525 ) ).add( pixel.y.mul( uint( 1013904223 ) ) ).add( frame.mul( uint( 2654435761 ) ) ).toVar()
	x.assign( x.bitXor( x.shiftRight( uint( 16 ) ) ) )
	x.assign( x.mul( uint( 0x7feb352d ) ) )
	x.assign( x.bitXor( x.shiftRight( uint( 15 ) ) ) )
	x.assign( x.mul( uint( 0x846ca68b ) ) )
	x.assign( x.bitXor( x.shiftRight( uint( 16 ) ) ) )
	return float( x.shiftRight( uint( 8 ) ) ).div( 16777216 ) as Node<'float'>

}
