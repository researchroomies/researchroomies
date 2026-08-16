declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

/** migrations/*.sql are imported as text by the handler fixtures. */
declare module '*.sql?raw' {
	const content: string;
	export default content;
}
