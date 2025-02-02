import { createRestAPIClient, type mastodon } from 'masto';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'node:fs';
import * as core from '@actions/core';
import { mkdirp } from 'mkdirp';
import { FeedData, type FeedEntry, read } from '@extractus/feed-extractor';
import crypto from 'crypto';
import Handlebars from 'handlebars';

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf-8').digest('hex');
}

async function writeCache(cacheFile: string, cacheLimit: number, cache: string[]): Promise<void> {
  try {
    // limit the cache
    if (cache.length > cacheLimit) {
      core.notice(`Cache limit reached. Removing ${cache.length - cacheLimit} items.`);
      cache = cache.slice(cache.length - cacheLimit);
    }

    // make sure the cache directory exists
    await mkdirp(cacheFile.substring(0, cacheFile.lastIndexOf('/')));

    // write the cache
    await writeFile(cacheFile, JSON.stringify(cache));
  } catch (e) {
    core.setFailed(`Failed to write cache file: ${(<Error>e).message}`);
  }
}

async function postItems(
  apiEndpoint: string,
  apiToken: string,
  feedData: FeedData | undefined,
  entries: FeedEntry[],
  statusTemplate: HandlebarsTemplateDelegate<any>,
  visibility: mastodon.v1.StatusVisibility,
  dryRun: boolean,
  sensitive: boolean,
  cache: string[],
  limit: number) {
  if (dryRun) {
    // Add new items to cache
    for (const item of entries) {
      try {
        const hash = sha256(<string>item.link);
        core.debug(`Adding ${item.title} with hash ${hash} to cache`);

        // add the item to the cache
        cache.push(hash);
      } catch (e) {
        core.setFailed(`Failed to ad item to cache: ${(<Error>e).message}`);
      }
    }

    return;
  }

  // authenticate with mastodon
  let masto: mastodon.rest.Client;
  try {
    masto = createRestAPIClient({
      url: apiEndpoint,
      accessToken: apiToken
    });
  } catch (e) {
    core.setFailed(`Failed to authenticate with Mastodon: ${(<Error>e).message}`);
    return;
  }

  // post the new items
  let postedItems: number = 0;
  for (const item of entries) {
    try {
      const hash = sha256(<string>item.link);
      core.debug(`Posting ${item.title} with hash ${hash}`);

      if (postedItems >= limit) {
        core.debug(`Skipping '${item.title}' with hash ${hash} due to post limit ${limit}`);
      } else {
        // post the item
        const res = await masto.v1.statuses.create({
          status: statusTemplate({ feedData, item }),
          visibility,
          sensitive
        }, {
          requestInit: {
            headers: new Headers({ 'Idempotency-Key': hash })
          }
        });
        core.debug(`Response:\n\n${JSON.stringify(res, null, 2)}`);

        postedItems++;
      }

      // add the item to the cache
      cache.push(hash);
    } catch (e) {
      core.setFailed(`Failed to post item: ${(<Error>e).message}`);
    }
  }
}

async function filterCachedItems(rss: FeedEntry[], cache: string[]): Promise<FeedEntry[]> {
  if (cache.length) {
    rss = rss
      ?.filter(item => {
        const hash = sha256(<string>item.link);
        return !cache.includes(hash);
      })
      ?.sort((a, b) => a.published?.localeCompare(b.published || '') || NaN);
  }
  core.debug(JSON.stringify(`Post-filter feed items:\n\n${JSON.stringify(rss, null, 2)}`));
  return rss;
}

async function getRss(rssFeed: string): Promise<FeedData | undefined> {
  let rss: FeedData;
  try {
    rss = <FeedData>(await read(rssFeed));
    core.debug(JSON.stringify(`Pre-filter feed items:\n\n${JSON.stringify(rss.entries, null, 2)}`));
    return rss;
  } catch (e) {
    core.setFailed(`Failed to parse RSS feed: ${(<Error>e).message}`);
  }
}

async function getCache(cacheFile: string): Promise<string[]> {
  let cache: string[] = [];
  try {
    cache = JSON.parse(await readFile(cacheFile, 'utf-8'));
    core.debug(`Cache: ${JSON.stringify(cache)}`);
    return cache;
  } catch (e) {
    core.notice(`Cache file not found. Creating new cache file at ${cacheFile}.`);
    return cache;
  }
}

export async function main(): Promise<void> {
  // get variables from environment
  const rssFeed = core.getInput('rss-feed', { required: true });
  core.debug(`rssFeed: ${rssFeed}`);
  const apiEndpoint = core.getInput('api-endpoint', { required: true });
  core.debug(`apiEndpoint: ${apiEndpoint}`);
  const apiToken = core.getInput('api-token', { required: true });
  core.debug(`apiToken: ${apiToken}`);
  const cacheFile = core.getInput('cache-file', { required: true });
  core.debug(`cacheFile: ${cacheFile}`);
  const cacheLimit = parseInt(core.getInput('cache-limit'), 10);
  core.debug(`cacheLimit: ${cacheLimit}`);
  const statusVisibility: mastodon.v1.StatusVisibility = <mastodon.v1.StatusVisibility>core.getInput('status-visibility', { trimWhitespace: true });
  core.debug(`statusVisibility: ${statusVisibility}`);
  const template: string = core.getInput('template', { required: true });
  core.debug(`template: ${template}`);
  const dryRun: boolean = core.getBooleanInput('dry-run');
  core.debug(`dryRun: ${dryRun}`);
  const sensitive: boolean = core.getBooleanInput('sensitive');
  core.debug(`sensitive: ${sensitive}`);
  const initialPostLimit = parseInt(core.getInput('initial-post-limit'), 10);
  core.debug(`initialPostLimit: ${initialPostLimit}`);
  const postLimit = parseInt(core.getInput('post-limit'), 10);
  core.debug(`postLimit: ${postLimit}`);

  if (initialPostLimit > cacheLimit) {
    core.warning('initial-post-limit is greater than cache-limit, this might lead to unexpected results');
  }
  if (postLimit > cacheLimit) {
    core.warning('post-limit is greater than cache-limit, this might lead to unexpected results');
  }

  // get the rss feed
  const feedData: FeedData | undefined = await getRss(rssFeed);
  const entries: FeedEntry[] = feedData?.entries ?? [];

  let limit: number = postLimit;
  let cache: string[] = [];

  // get the cache
  if (!existsSync(cacheFile)) {
    limit = initialPostLimit;
  } else {
    cache = await getCache(cacheFile);
  }

  // filter out the cached items
  const filteredEntries: FeedEntry[] = await filterCachedItems(entries, cache);

  // post the new items
  const statusTemplate = Handlebars.compile(template);
  await postItems(
    apiEndpoint,
    apiToken,
    feedData,
    filteredEntries,
    statusTemplate,
    statusVisibility,
    dryRun,
    sensitive,
    cache,
    limit);

  // write the cache
  await writeCache(cacheFile, cacheLimit, cache);
}

(async () => await main())();
