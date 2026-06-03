import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../crypto";

const SECRET = "test-encryption-key-32-chars-long!!";

describe("encrypt/decrypt", () => {
	it("round-trips plaintext", async () => {
		const plaintext = "neo4j:super-secret-password";
		const { ciphertext, iv } = await encrypt(plaintext, SECRET);
		const result = await decrypt(ciphertext, iv, SECRET);
		expect(result).toBe(plaintext);
	});

	it("produces different ciphertext for same input (random IV)", async () => {
		const plaintext = "same-input";
		const a = await encrypt(plaintext, SECRET);
		const b = await encrypt(plaintext, SECRET);
		expect(a.ciphertext).not.toBe(b.ciphertext);
		expect(a.iv).not.toBe(b.iv);
	});

	it("fails with wrong key", async () => {
		const { ciphertext, iv } = await encrypt("secret", SECRET);
		await expect(
			decrypt(ciphertext, iv, "wrong-key-that-is-different!!"),
		).rejects.toThrow();
	});

	it("handles empty string", async () => {
		const { ciphertext, iv } = await encrypt("", SECRET);
		const result = await decrypt(ciphertext, iv, SECRET);
		expect(result).toBe("");
	});

	it("handles unicode content", async () => {
		const plaintext = "neo4j:p@$$wörd-日本語";
		const { ciphertext, iv } = await encrypt(plaintext, SECRET);
		const result = await decrypt(ciphertext, iv, SECRET);
		expect(result).toBe(plaintext);
	});
});
