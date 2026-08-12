declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

/** db/schema.sql is imported as text by the handler fixtures. */
declare module '*.sql?raw' {
	const content: string;
	export default content;
}
