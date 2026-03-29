#!/usr/bin/env node

import axios from "axios";
import { parseDocument } from "htmlparser2";
import { findAll, textContent } from "domutils";
import type { Element } from "domhandler";
import { downloadFileWithProgress } from "./download.js";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import cliProgress from "cli-progress";
import { checkbox, confirm, input } from "@inquirer/prompts";
import Parser from "rss-parser";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS & TYPES
// ═══════════════════════════════════════════════════════════════════════════════

const RSS_FEED = "http://fitgirl-repacks.site/feed/";
const VERSION = "1.1.3";
const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), "Downloads", "Fitgirl Repacks");
const CONFIG_FILE = Bun.file(path.join(DEFAULT_DOWNLOAD_DIR, "config.json"));
const HOME_PREFIX = "https://fitgirl-repacks.site/";
const HOST_PREFIX = "https://fuckingfast.co";

export type LinkItem = {
  href: string;
  text: string;
};

type Config = {
  item: {
    link: string;
    files: LinkItem[];
    selected: LinkItem[];
  }[];
};

const dummyConfig: Config = {
  item: [],
};
const parser: Parser = new Parser();

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

async function readConfig(url?: string) {
  try {
    const config: Config = JSON.parse(await CONFIG_FILE.text());

    if (url != undefined) {
      return config.item.filter((item) => item.link == url)[0];
    }

    return config;
  } catch (e) {
    return dummyConfig;
  }
}

async function writeConfig(itemConfig: Config["item"][0]) {
  let config = (await readConfig()) as Config;

  const links = config.item.map((item) => item.link);
  const itemIndex = links.indexOf(itemConfig.link);

  if (itemIndex >= 0) {
    config.item[itemIndex] = itemConfig;
  } else {
    config.item.push(itemConfig);
  }

  await CONFIG_FILE.write(JSON.stringify(config));
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(2)} ${units[i]}`;
}

function printBanner(): void {
  console.log(
    chalk.cyan(`
  ╔═══════════════════════════════════════════════════════════════╗
  ║                                                               ║
  ║   ${chalk.bold.white("🎮 FitGirl Repack Downloader")}                                ║
  ║   ${chalk.gray(`v${VERSION}`)}                                                      ║
  ║                                                               ║
  ╚═══════════════════════════════════════════════════════════════╝
  `),
  );
}

function printSuccess(message: string): void {
  console.log(chalk.green("✔"), chalk.white(message));
}

function printError(message: string): void {
  console.log(chalk.red("✖"), chalk.white(message));
}

function printInfo(message: string): void {
  console.log(chalk.blue("ℹ"), chalk.white(message));
}

function printWarning(message: string): void {
  console.log(chalk.yellow("⚠"), chalk.white(message));
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getDownloadLinks(url: string, hrefPrefix: string): Promise<LinkItem[]> {
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const dom = parseDocument(data);

  const anchors = findAll((node): node is Element => node.type === "tag" && node.name === "a", dom.children);

  const items = anchors
    .filter((x) => x.attribs?.href && x?.attribs?.href?.startsWith(hrefPrefix))
    .map((a) => {
      const rawHref = a.attribs?.href;
      if (!rawHref) return null;
      const href = new URL(rawHref, url).toString();
      const text = textContent(a).trim();
      return { href, text } as LinkItem;
    })
    .filter((x): x is LinkItem => !!x);

  const dedup = new Map<string, LinkItem>();
  for (const it of items) if (!dedup.has(it.href)) dedup.set(it.href, it);

  return [...dedup.values()];
}

async function getNestedDownloadLink(url: string): Promise<string | null> {
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const m = data.match(/window\.open\(\s*["']([^"']+)["']\s*\)/);
  return m?.[1] ?? null;
}

async function downloadWithProgressBar(
  url: string,
  outputDir: string,
  filename: string,
  index: number,
  total: number,
): Promise<void> {
  const multibar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: `  ${chalk.cyan("{bar}")} │ ${chalk.yellow(
        "{percentage}%",
      )} │ ${chalk.green("{downloaded}")} / ${chalk.blue("{fileSize}")} │ ${chalk.magenta("{speed}")} | ${chalk.yellow("{eta}s")}/${chalk.blue("{duration}s")}`,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      barsize: 30,
    },
    cliProgress.Presets.shades_classic,
  );

  const bar = multibar.create(100, 0, {
    downloaded: "0 B",
    fileSize: "Unknown",
    speed: "0 B/s",
  });

  try {
    await downloadFileWithProgress(url, outputDir, (progress) => {
      const { downloadedBytes, totalBytes, percent, rateBps } = progress;

      bar.update(percent ?? 0, {
        downloaded: formatBytes(downloadedBytes),
        fileSize: totalBytes ? formatBytes(totalBytes) : "Unknown",
        speed: rateBps ? `${formatBytes(rateBps)}/s` : "0 B/s",
      });
    });

    bar.update(100);
    multibar.stop();
    printSuccess(`Downloaded: ${chalk.bold(filename)}`);
  } catch (error) {
    multibar.stop();
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN CLI LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

async function downloadGame(
  url: string,
  outputDir: string,
  skipPrompt: boolean,
  bannerAlreadyShown: boolean = false,
): Promise<void> {
  if (!bannerAlreadyShown) {
    printBanner();
  }

  let dLinks: LinkItem[];
  let selectedLinks: LinkItem[];

  const prevConfig = (await readConfig(url)) as Config["item"][0];
  let usePrevConfig = false;
  if (prevConfig) {
    console.log("Previous selected item(s):");
    for (const prevItem of prevConfig.selected) {
      console.log(`${chalk.blue(prevItem.text)}`);
    }
    console.log("");
    usePrevConfig = await confirm({
      message: `Use previous download config (${prevConfig.selected.length} selected file(s))?`,
      default: true,
    });
  }

  if (!usePrevConfig) {
    printInfo(`Fetching download links from: ${chalk.underline(url)}`);
    console.log();

    const spinner = ora({
      text: "Scanning page for download links...",
      color: "cyan",
    }).start();

    try {
      dLinks = await getDownloadLinks(url, HOST_PREFIX);
      spinner.succeed(`Found ${chalk.bold(dLinks.length)} download link(s)`);
    } catch (error) {
      spinner.fail("Failed to fetch download links");
      printError(error instanceof Error ? error.message : "Unknown error");
      process.exit(1);
    }

    if (dLinks.length === 0) {
      printWarning("No download links found on this page.");
      process.exit(0);
    }

    console.log();

    // Let user select which files to download

    if (skipPrompt) {
      selectedLinks = dLinks;
      printInfo(`Downloading all ${selectedLinks.length} file(s)`);
    } else {
      const choices = dLinks.map((link, i) => ({
        name: `${link.text || `File ${i + 1}`}`,
        value: link,
        checked: true,
      }));

      selectedLinks = await checkbox({
        message: chalk.bold("Select files to download:"),
        choices,
        pageSize: 15,
      });

      if (selectedLinks.length === 0) {
        printWarning("No files selected. Exiting.");
        process.exit(0);
      }
    }
  } else {
    dLinks = prevConfig.files;
    selectedLinks = prevConfig.selected;
  }

  if (outputDir == DEFAULT_DOWNLOAD_DIR) {
    const dirname = selectedLinks[0].text.split("_–_")[0].replaceAll("_", " ");
    outputDir = path.join(DEFAULT_DOWNLOAD_DIR, dirname);
  }

  console.log();
  printInfo(`Download directory: ${chalk.underline(outputDir)}`);
  console.log();

  // Confirm before downloading
  if (!skipPrompt) {
    const shouldProceed = await confirm({
      message: `Start downloading ${selectedLinks.length} file(s)?`,
      default: true,
    });

    if (!shouldProceed) {
      printWarning("Download cancelled.");
      process.exit(0);
    }
  }

  console.log();
  console.log(chalk.bold.cyan("  📥 Starting downloads...\n"));
  await writeConfig({
    link: url,
    files: dLinks,
    selected: selectedLinks,
  });

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < selectedLinks.length; i++) {
    const dLink = selectedLinks[i];
    const fileLabel = dLink.text || `File ${i + 1}`;

    console.log(chalk.dim(`  [${i + 1}/${selectedLinks.length}]`));

    const linkSpinner = ora({
      text: `Processing: ${fileLabel}`,
      color: "yellow",
      indent: 2,
    }).start();

    try {
      const nLink = await getNestedDownloadLink(dLink.href);

      if (!nLink) {
        linkSpinner.fail();
        failCount++;
        continue;
      }

      linkSpinner.succeed();

      await downloadWithProgressBar(nLink, outputDir, fileLabel, i + 1, selectedLinks.length);
      successCount++;
    } catch (error) {
      linkSpinner.fail();
      printError(error instanceof Error ? error.message : "Unknown error");
      failCount++;
    }

    console.log();
  }

  // Summary
  console.log(chalk.bold.cyan("\n  ════════════════════════════════════════════════════\n"));
  console.log(chalk.bold("  📊 Download Summary:"));
  console.log(`     ${chalk.green("✔")} Successful: ${chalk.bold.green(successCount)}`);
  console.log(`     ${chalk.red("✖")} Failed: ${chalk.bold.red(failCount)}`);
  console.log(`     ${chalk.blue("📁")} Location: ${chalk.underline(outputDir)}`);
  console.log(chalk.bold.cyan("\n  ════════════════════════════════════════════════════\n"));

  if (failCount > 0) {
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI SETUP
// ═══════════════════════════════════════════════════════════════════════════════

const program = new Command();

program
  .name("fitgirl-dl")
  .description(chalk.cyan("🎮 A beautiful CLI tool to download FitGirl Repacks"))
  .version(VERSION, "-v, --version", "Display version number")
  .argument("[url]", "URL of the FitGirl repack page (will prompt if not provided)")
  .option("-o, --output <dir>", "Output directory for downloads", DEFAULT_DOWNLOAD_DIR)
  .option("-y, --yes", "Skip confirmation prompts and download all files", false)
  .action(async (url: string | undefined, options: { output: string; yes: boolean }) => {
    try {
      let targetUrl = url;

      if (!(await CONFIG_FILE.exists())) {
        await CONFIG_FILE.write(JSON.stringify(dummyConfig));
      }

      // If no URL provided, prompt for it
      if (!targetUrl) {
        printBanner();
        let feed = await parser.parseURL(RSS_FEED);
        console.log("Latest Fitgirl Repacks:");
        for (const i in feed.items) {
          const itemFeed = feed.items[i];
          if (itemFeed.categories?.[0] != "Uncategorized") {
            console.log(`${chalk.blue("[" + i + "]")} ${itemFeed.title}`);
          }
        }

        console.log("");

        const config = (await readConfig()) as Config;
        if (config?.item.length > 0) {
          console.log("Previous downloaded repacks:");
          for (const i in config.item) {
            console.log(`${chalk.blue("[" + feed.items.length + "]")} ${config.item[i].link}`);
            feed.items.push({
              link: config.item[i].link,
            });
          }
        }

        console.log("");

        await input({
          message: chalk.bold("Enter FitGirl repack page URL or number above:"),
          validate: (value) => {
            if (!value.trim()) {
              return "URL is required";
            }
            try {
              if (value.startsWith(HOME_PREFIX)) {
                new URL(value);
                targetUrl = value;
              } else {
                const selIndex = parseInt(value);

                if (isNaN(selIndex) || selIndex > feed.items.length - 1) {
                  return "Select a valid number";
                }

                targetUrl = feed.items[selIndex].link!;
              }

              return true;
            } catch {
              return "Please enter a valid URL";
            }
          },
        });
        console.log();
        await downloadGame(targetUrl!, options.output, options.yes, true);
      } else {
        await downloadGame(targetUrl, options.output, options.yes);
      }
    } catch (error) {
      printError(error instanceof Error ? error.message : "An unexpected error occurred");
      process.exit(1);
    }
  });

program.parse();
