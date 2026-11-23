/**
 * 按块读取，回调已下字节。没有 Content-Length 时用 expected。
 *
 * 对照 interior-mapping-webgpu `src/load/fetchBuffer.ts`。
 *
 * @param url - 站根相对或绝对 URL。
 * @param onBytes - 每次读到一块就报 `loaded / total`。
 * @param expected - 响应没有 Content-Length 时的字节下限。
 * @returns 完整 ArrayBuffer。
 */
export async function fetchBuffer(
	url: string,
	onBytes: ( loaded: number, total: number ) => void,
	expected = 0,
): Promise<ArrayBuffer> {

	const res = await fetch( url )
	if ( ! res.ok ) throw new Error( `[load] ${ url } ${ res.status }` )

	const header = Number( res.headers.get( 'content-length' ) ) || 0
	let total = header > 0 ? header : expected
	const reader = res.body?.getReader()
	if ( reader === undefined ) {
		const buf = await res.arrayBuffer()
		onBytes( buf.byteLength, buf.byteLength )
		return buf
	}

	const chunks: Uint8Array[] = []
	let loaded = 0
	for ( ;; ) {
		const { done, value } = await reader.read()
		if ( done ) break
		chunks.push( value )
		loaded += value.byteLength
		if ( total < loaded ) total = loaded
		onBytes( loaded, total )
	}

	const out = new Uint8Array( loaded )
	let offset = 0
	for ( const chunk of chunks ) {
		out.set( chunk, offset )
		offset += chunk.byteLength
	}
	return out.buffer

}
