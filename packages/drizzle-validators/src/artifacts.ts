import { readFile, readdir } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { GENERATED_HEADER } from "./file-writer";
import type { ValidatorTarget } from "./adapters/types";
import type { GeneratedData, TableCodeData } from "./types";


/**
 * Reconstructs virtual-module content from previously written generated
 * files — the serving path when regenOnBuild is not enabled.
 *
 * Split mode: each per-table file is served verbatim as the table's
 * submodule (its alias exports are additive and harmless in the virtual
 * context), and the root barrel is synthesized from the tables' aliased
 * export names. Single-file mode: the file's content is the root module;
 * per-table submodules are unavailable (they were never written).
 *
 * Returns null when no recognizable artifacts exist — the caller turns
 * that into an actionable error.
 */

// Tolerant of formatter output (Prettier/Biome add trailing semicolons,
// adjust spacing, may emit a BOM) — committed artifacts get linted.
const ALIAS_LINE =
	/^export const ([A-Za-z0-9_$]+)\s*=\s*(insertSchema|selectSchema|updateSchema)\s*;?$/;

function hasGeneratedHeader(code: string): boolean {
	return code
		.replace(/^\uFEFF/, "")
		.trimStart()
		.startsWith(GENERATED_HEADER);
}

function collectAliases(code: string): Array<[string, string]> {
	const aliases: Array<[string, string]> = [];
	for (const line of code.split("\n")) {
		const match = ALIAS_LINE.exec(line.trim());
		if (match) aliases.push([match[2]!, match[1]!]);
	}
	return aliases;
}

export async function readGeneratedArtifacts(opts: {
	outputDir: string;
	absoluteOutputPath: string;
	splitByTable: boolean;
	moduleId: string;
	target: ValidatorTarget;
	importStatement: string;
	refineExportStatement?: string;
}): Promise<GeneratedData | null> {
	const {
		outputDir,
		absoluteOutputPath,
		splitByTable,
		moduleId,
		target,
		importStatement,
		refineExportStatement,
	} = opts;

	if (!splitByTable) {
		let singleFileCode: string;
		try {
			singleFileCode = await readFile(absoluteOutputPath, "utf8");
		} catch {
			return null;
		}
		if (!hasGeneratedHeader(singleFileCode)) return null;

		const exportNames = [
			...singleFileCode.matchAll(/^export const ([A-Za-z0-9_$]+)\s*=/gm),
		].map((m) => m[1]!);

		// Single-file artifacts are served for per-table submodule imports
		// too (dts-builder declares them and dev serves them): each
		// submodule becomes a tiny re-export shim over the root virtual
		// module, which already holds the real schemas.
		const tableCodes = new Map<string, TableCodeData>();
		for (const name of exportNames) {
			const tableName = /^(.+)InsertSchema$/.exec(name)?.[1];
			if (!tableName) continue;
			const allAliases: Array<[string, string]> = [
				[`${tableName}InsertSchema`, "insertSchema"],
				[`${tableName}SelectSchema`, "selectSchema"],
				[`${tableName}UpdateSchema`, "updateSchema"],
			];
			const aliases = allAliases.filter(([alias]) =>
				exportNames.includes(alias),
			);
			if (aliases.length === 0) continue;
			tableCodes.set(tableName, {
				code:
					`${GENERATED_HEADER}\n` +
					`export { ${aliases.map(([alias, generic]) => `${alias} as ${generic}`).join(", ")} } from '${moduleId}';\n`,
				exportNames: aliases.map(([, generic]) => generic),
				// codes are only consumed by cache equality checks, which the
				// no-generation path never runs; the served content is `code`.
				codes: ["", "", ""],
			});
		}

		return {
			code: singleFileCode,
			singleFileCode,
			exportNames,
			tableCodes,
			depPaths: [],
			target,
			importStatement,
			refineExportStatement,
		};
	}

	let entries: string[];
	try {
		entries = await readdir(outputDir);
	} catch {
		return null;
	}

	const tableFiles = entries
		.filter((e) => e.endsWith(".ts") && !e.endsWith(".d.ts") && e !== "index.ts")
		.sort();

	const tableCodes = new Map<string, TableCodeData>();
	const barrelLines: string[] = [
		GENERATED_HEADER,
		...(refineExportStatement ? [refineExportStatement] : []),
		"",
	];

	for (const file of tableFiles) {
		const tableName = file.slice(0, -3);
		const filePath = joinPath(outputDir, file);
		let code: string;
		try {
			code = await readFile(filePath, "utf8");
		} catch {
			continue;
		}
		if (!hasGeneratedHeader(code)) continue;

		const aliases = collectAliases(code);
		if (aliases.length === 0) continue;

		tableCodes.set(tableName, {
			code,
			exportNames: aliases.map(([, alias]) => alias),
			// codes are only consumed by cache equality checks, which the
			// no-generation path never runs; the served content is `code`.
			codes: [code, code, code],
		});
		barrelLines.push(
			`export { ${aliases.map(([generic, alias]) => `${generic} as ${alias}`).join(", ")} } from '${moduleId}/${tableName}'`,
		);
	}

	if (tableCodes.size === 0) return null;

	return {
		code: barrelLines.join("\n"),
		singleFileCode: "",
		exportNames: [...tableCodes.values()].flatMap((t) => t.exportNames),
		tableCodes,
		depPaths: [],
		target,
		importStatement,
		refineExportStatement,
	};
}
