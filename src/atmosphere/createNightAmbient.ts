import {
	Color,
	HemisphereLight,
	type Scene,
} from 'three'

/**
 * {@link createNightAmbient} 装上的夜底光句柄。
 *
 * 半球光抬影调：朝上吃天色、朝下吃地面色；距离雾由后处理管线（SSF）负责。
 * 不装环境光 / 方向光，也不写 `scene.fog`。
 */
export interface NightAmbientHandle {
	/** 夜半球光（天冷、地暗） */
	hemi: HemisphereLight
	/** 从场景卸半球光 */
	dispose: () => void
}

/**
 * 夜氛围底光选项。
 */
export interface NightAmbientOptions {
	/**
	 * 清屏 / 背景色（深青黑）。雾色不写在这里，只进 SSF 雾参。
	 * @defaultValue `0x0c141c`
	 */
	backgroundColor?: number
	/**
	 * 半球天上颜色。朝上的屋顶 / 地面主要吃这一层。
	 * @defaultValue `0x4e6a82`
	 */
	skyColor?: number
	/**
	 * 半球地面颜色。檐底 / 朝下的面吃这一层，比天色暗，避免把阴影翻亮。
	 * @defaultValue `0x101820`
	 */
	groundColor?: number
	/**
	 * 半球光强度。只抬一层冷亮，不抢灯笼点光。
	 * 比旧环境光 0.15 略高：墙面只吃天/地混合，需要一点余量才能把巷子中灰抬起来。
	 * @defaultValue `0.22`
	 */
	intensity?: number
}

/** 夜氛围默认：弱半球光 + 深色清屏。 */
const NIGHT = {
	backgroundColor: 0x0c141c,
	skyColor: 0x4e6a82,
	groundColor: 0x101820,
	intensity: 0.22,
} as const

/**
 * 装夜氛围底光：一盏半球光，并写清屏深色。
 *
 * 原理：雨夜主光来自灯位表点光与自发光材质；半球光只避免影里死黑，
 * 并让朝上天面比檐底多一点可读性。清屏色与夜空穹顶衔接；
 * `scene.fog` 置空，避免与后处理雾叠成双重雾。
 *
 * @param scene - 目标场景
 * @param options - 背景色 / 天色 / 地色 / 强度覆盖
 * @returns 底光句柄与 dispose
 */
export function createNightAmbient( scene: Scene, options: NightAmbientOptions = {} ): NightAmbientHandle {

	const backgroundColor = new Color( options.backgroundColor ?? NIGHT.backgroundColor )
	const skyColor = options.skyColor ?? NIGHT.skyColor
	const groundColor = options.groundColor ?? NIGHT.groundColor
	const intensity = options.intensity ?? NIGHT.intensity

	scene.fog = null
	scene.background = backgroundColor.clone()

	const hemi = new HemisphereLight( skyColor, groundColor, intensity )
	hemi.name = 'NightHemi'
	scene.add( hemi )

	return {
		hemi,
		dispose: () => {

			scene.remove( hemi )
			hemi.dispose()

		},
	}

}
