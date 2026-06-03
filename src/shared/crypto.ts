const SALT = new TextEncoder().encode("kg-credential-encryption");

async function deriveKey(secret: string): Promise<CryptoKey> {
	const raw = new TextEncoder().encode(secret);
	const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: SALT, info: new Uint8Array() },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

function toBase64(buf: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const buf = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
	return buf;
}

export async function encrypt(
	plaintext: string,
	secret: string,
): Promise<{ ciphertext: string; iv: string }> {
	const key = await deriveKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	return { ciphertext: toBase64(encrypted), iv: toBase64(iv.buffer) };
}

export async function decrypt(
	ciphertext: string,
	iv: string,
	secret: string,
): Promise<string> {
	const key = await deriveKey(secret);
	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64(iv) },
		key,
		fromBase64(ciphertext),
	);
	return new TextDecoder().decode(decrypted);
}
