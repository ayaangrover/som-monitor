import { type } from "arktype";
import { scrape, ShopItems, type ShopItem } from "./scrape";
import { DeletedItem, NewItem, UpdatedItem, UsergroupPing } from "./blocks";
import { JSXSlack } from "jsx-slack";
import { readFile, writeFile, exists } from "node:fs/promises";
import { deepEquals } from "bun";
import { WebClient } from "@slack/web-api";
import { Cron } from "croner";
import * as Sentry from "@sentry/bun";

const envSchema = type({
  SOM_COOKIE: "string",
  SLACK_CHANNEL_ID: "string",
  SLACK_XOXB: "string",
  SLACK_USERGROUP_ID: "string",
  OLD_ITEMS_PATH: "string = 'items.json'",
  BLOCKS_LOG_PATH: "string?",
  SENTRY_DSN: "string?",
});
const env = envSchema.assert(process.env);

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    sendDefaultPii: true,
    tracesSampleRate: 1.0,
  });
}

const SLACK_BLOCK_LIMIT = 50;

async function retry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < retries - 1) {
        console.warn(`Attempt ${i + 1} failed. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function uploadImagesForItems(items: ShopItem[]) {
  const imagesToUpload: string[] = [];
  const itemToImageIndex = new Map<ShopItem, number>();

  for (const item of items) {
    if (item.imageUrl) {
      itemToImageIndex.set(item, imagesToUpload.length);
      imagesToUpload.push(item.imageUrl);
    }
  }

  if (imagesToUpload.length > 0) {
    const uploaded = await uploadToCdn(imagesToUpload);
    for (const [item, idx] of itemToImageIndex.entries()) {
      item.imageUrl = uploaded[idx]!.deployedUrl;
    }
  }
}

function shouldNotifyUsergroup(oldItem: ShopItem, newItem: ShopItem): boolean {
  const ignoreKeys = ["title", "description"];
  const importantChange = Object.keys(newItem).some((key) => {
    if (ignoreKeys.includes(key)) return false;
    const oldVal = (oldItem as any)[key];
    const newVal = (newItem as any)[key];

    if (key === "stockRemaining") {
      if (typeof oldVal === "number" && typeof newVal === "number") {
        return Math.abs(oldVal - newVal) > 1;
      }
    }

    return !deepEquals(oldVal, newVal);
  });

  return importantChange;
}

async function run() {
  try {
    const slack = new WebClient(env.SLACK_XOXB);

    const currentItems = await retry(() => scrape(env.SOM_COOKIE));
    await uploadImagesForItems(currentItems);

    if (!(await exists(env.OLD_ITEMS_PATH))) {
      await writeItems(currentItems);
      console.log(
        `👋 First sync successful! Writing to \`${env.OLD_ITEMS_PATH}\``
      );
      return;
    }

    const oldItems = ShopItems(
      JSON.parse(await readFile(env.OLD_ITEMS_PATH, { encoding: "utf-8" }))
    );
    if (oldItems instanceof type.errors) {
      throw new Error(oldItems.summary);
    }

    if (deepEquals(oldItems, currentItems)) {
      console.log("✨ No shop updates detected.");
      return;
    }

    const updates = [];
    const newItemNames: string[] = [];
    const updatedItemNames: string[] = [];
    const deletedItemNames: string[] = [];
    let shouldPingUsergroup = false;

    for (const currentItem of currentItems) {
      const oldItem = oldItems.find((item) => item.id === currentItem.id);

      if (!oldItem) {
        updates.push(JSXSlack(NewItem({ item: currentItem })));
        newItemNames.push(currentItem.title);
        shouldPingUsergroup = true;
        continue;
      }

      if (deepEquals(oldItem, currentItem)) {
        continue;
      }

      updates.push(JSXSlack(UpdatedItem({ oldItem, newItem: currentItem })));
      updatedItemNames.push(oldItem.title);

      if (shouldNotifyUsergroup(oldItem, currentItem)) {
        shouldPingUsergroup = true;
      }
    }

    for (const oldItem of oldItems) {
      const currentItem = currentItems.find((item) => item.id === oldItem.id);
      if (!currentItem) {
        updates.push(JSXSlack(DeletedItem({ item: oldItem })));
        deletedItemNames.push(oldItem.title);
        shouldPingUsergroup = true;
      }
    }

    await writeItems(currentItems);

    console.log(`📰 ${updates.length} updates found.`);
    if (env.BLOCKS_LOG_PATH) {
      await writeFile(env.BLOCKS_LOG_PATH, JSON.stringify(updates, null, 2));
    }

    const notificationTexts = [];
    if (newItemNames.length > 0) {
      notificationTexts.push(`*new items:* ${newItemNames.join(", ")}`);
    }
    if (deletedItemNames.length > 0) {
      notificationTexts.push(`*deleted items:* ${deletedItemNames.join(", ")}`);
    }
    if (updatedItemNames.length > 0) {
      notificationTexts.push(`*updated items:* ${updatedItemNames.join(", ")}`);
    }
    const notificationText = `✨ ${notificationTexts.join(" · ")}`;

    const allBlocks = updates.flat();
    if (allBlocks.length === 0) throw new Error("Updates were detected, but we have no update blocks. This should never happen.");

    for (let i = 0; i < allBlocks.length; i += SLACK_BLOCK_LIMIT) {
      const chunk = allBlocks.slice(i, i + SLACK_BLOCK_LIMIT);
      const result = await retry(() =>
        slack.chat.postMessage({
          text: notificationText,
          blocks: chunk,
          channel: env.SLACK_CHANNEL_ID,
          unfurl_links: false,
          unfurl_media: false,
        })
      );
      if (!result.ok) {
        throw new Error(
          `Failed to send chunked Slack message: ${result.error}`
        );
      }
    }

    if (shouldPingUsergroup) {
      await retry(() =>
        slack.chat.postMessage({
          text: notificationText,
          blocks: JSXSlack(
            UsergroupPing({ usergroupId: env.SLACK_USERGROUP_ID })
          ),
          channel: env.SLACK_CHANNEL_ID,
          unfurl_links: false,
          unfurl_media: false,
        })
      );
    }

    console.log("🙌 Run completed!");
  } catch (error) {
    console.error("Fatal error during run:", error);
    Sentry.captureException(error);
    process.exit(1);
  }
}

new Cron("* * * * *", { maxRuns: 1, name: "shop-scraper" }, run);
run();

async function writeItems(newItems: ShopItem[]) {
  await writeFile(env.OLD_ITEMS_PATH, JSON.stringify(newItems, null, 2));
}

const cdnResponseSchema = type({
  files: type({
    deployedUrl: "string.url",
  }).array(),
});

async function uploadToCdn(urls: string[]) {
  const res = await retry(() =>
    fetch("https://cdn.hackclub.com/api/v3/new", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer beans",
      },
      body: JSON.stringify(urls),
    })
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Error occurred whilst uploading ${urls} to CDN: ${text}`);
  }

  const json = cdnResponseSchema.assert(JSON.parse(text));
  console.log(`⬆️ Uploaded ${urls.length} files to CDN.`);
  return json.files;
}
