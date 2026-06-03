export function getAuthenticatedEmail(request: Request): string | null {
	const email = request.headers.get("CF-Access-Authenticated-User-Email");
	if (email) return email;

	// Service tokens: Access consumes the Client-Id/Secret headers and
	// forwards only a JWT. Decode it to extract the common_name (service
	// token ID) as proof of authentication.
	const jwt = request.headers.get("CF-Access-JWT-Assertion");
	if (jwt) {
		try {
			const payload = JSON.parse(atob(jwt.split(".")[1]));
			if (payload.common_name) {
				return `service-token:${payload.common_name}`;
			}
		} catch {
			// malformed JWT — fall through
		}
	}

	return null;
}

export function isFactoryAdmin(email: string, env: FactoryEnv): boolean {
	if (email.startsWith("service-token:")) return true;
	const admins = env.FACTORY_ADMINS.split(",").map((e) =>
		e.trim().toLowerCase(),
	);
	return admins.includes(email.toLowerCase());
}
