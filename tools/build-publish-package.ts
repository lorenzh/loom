#!/usr/bin/env bun

import { resolve, join } from "node:path";

const STRIP_FIELDS = ["scripts", "devDependencies", "peerDependencies", "main"];

const packageDir = resolve(process.argv[2] ?? ".");
const distDir = join(packageDir, "dist");

const workspaceRoot = resolve(packageDir, "../..");
const rootPkg = await Bun.file(join(workspaceRoot, "package.json")).json();
const pkg = await Bun.file(join(packageDir, "package.json")).json();
const pub = await Bun.file(join(packageDir, "package.pub.json")).json();

for (const field of STRIP_FIELDS) {
	delete pkg[field];
}

const merged = { ...pkg, ...pub };
merged.version = rootPkg.version;

if (merged.dependencies) {
	for (const [name, version] of Object.entries(merged.dependencies)) {
		if (typeof version === "string" && version.startsWith("workspace:")) {
			merged.dependencies[name] = rootPkg.version;
		}
	}
}

await Bun.write(join(distDir, "package.json"), JSON.stringify(merged, null, 2) + "\n");
console.log(`wrote dist/package.json`);

const readme = Bun.file(join(packageDir, "README.md"));
if (await readme.exists()) {
	await Bun.write(join(distDir, "README.md"), readme);
	console.log(`copied README.md`);
}
