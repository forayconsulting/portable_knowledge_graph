export function getAuthenticatedEmail(request: Request): string | null {
	return request.headers.get("CF-Access-Authenticated-User-Email");
}

export function isFactoryAdmin(email: string, env: FactoryEnv): boolean {
	const admins = env.FACTORY_ADMINS.split(",").map((e) =>
		e.trim().toLowerCase(),
	);
	return admins.includes(email.toLowerCase());
}
