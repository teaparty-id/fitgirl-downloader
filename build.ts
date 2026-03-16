const matrix = ["macos-x64", "macos-arm64", "linux-x64", "windows-x64"];

for (const target of matrix) {
  console.log("Building target: " + target);
  await Bun.build({
    entrypoints: ["./src/index.ts"],
    compile: {
      target: "bun-" + target,
      outfile: "./bin/fgdl-" + target,
    },
  });
}

export {};
