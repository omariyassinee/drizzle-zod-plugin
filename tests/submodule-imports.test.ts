import { expect, test } from "bun:test";
import { loadModule } from "../src/module";

test("loads table-specific sub-module (virtual:drizzle-zod/users)", async () => {
	const usersMod = (await loadModule("virtual:drizzle-zod/users")) as Record<
		string,
		any
	>;

	expect(usersMod).toBeDefined();

	// Generic short schema exports
	expect(usersMod.insertSchema).toBeDefined();
	expect(usersMod.selectSchema).toBeDefined();
	expect(usersMod.updateSchema).toBeDefined();

	// Make sure table-prefixed duplicate names are NOT exported in sub-modules
	expect(usersMod.usersInsertSchema).toBeUndefined();
	expect(usersMod.usersSelectSchema).toBeUndefined();
	expect(usersMod.usersUpdateSchema).toBeUndefined();

	// Validate functionality of generic short schemas
	const validUser = usersMod.insertSchema.parse({
		name: "Bob",
		email: "bob@example.com",
	});
	expect(validUser.name).toBe("Bob");
});

test("loads table-specific sub-module (virtual:drizzle-zod/posts)", async () => {
	const postsMod = (await loadModule("virtual:drizzle-zod/posts")) as Record<
		string,
		any
	>;

	expect(postsMod).toBeDefined();
	expect(postsMod.insertSchema).toBeDefined();
	expect(postsMod.postsInsertSchema).toBeUndefined();

	const validPost = postsMod.insertSchema.parse({
		authorId: "123e4567-e89b-12d3-a456-426614174000",
		title: "Hello Virtual Submodules",
		slug: "hello-virtual-submodules",
		content: "Submodule imports work cleanly!",
	});
	expect(validPost.title).toBe("Hello Virtual Submodules");
});
