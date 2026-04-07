# Masto Feed Bot

Masto Feed Bot is a GitHub Action that posts RSS/ATOM feeds to Mastodon via GitHub Actions workflows.

## Usage

1. Go to `https://${YOUR_INSTANCE}/settings/applications/new` and add a new application.
   - Name it whatever you want.
   - The redirect URI is not important, so you can use `urn:ietf:wg:oauth:2.0:oob`.
   - The only permission required is `write:statuses`.
   - Save it, click on the application link, and grab the access token.

2. Create a new GitHub repository.
3. Go to your repository settings at `https://github.com/${YOUR_REPO}/settings/secrets/actions/new`, and add a new
   secret with the value of the access token.
4. Add a file named `.github/workflows/mastofeedbot.yml` with the following content:

    ```yaml
    name: FeedBot
    on:
      schedule:
        # This will run every five minutes. Alter it using https://crontab.guru/.
        - cron: '*/5 * * * *'
    jobs:
      rss-to-mastodon:
        runs-on: ubuntu-latest
        steps:
          - name: Generate cache key
            uses: actions/github-script@v7
            id: generate-key
            with:
              script: |
                core.setOutput('cache-key', new Date().valueOf())
          - name: Retrieve cache
            uses: actions/cache@v4
            with:
              path: ${{ github.workspace }}/mastofeedbot
              key: feed-cache-${{ steps.generate-key.outputs.cache-key }}
              restore-keys: feed-cache-
          - name: GitHub
            uses: 'joschi/mastofeedbot@v1'
            with:
              # This is the RSS feed you want to publish
              rss-feed: https://www.githubstatus.com/history.rss
              # Template of status posted to Mastodon (Handlebars)
              template: |
                {{item.title}}
                
                {{item.link}}
              # Visibility of the posted status (public | unlisted | private | direct)
              status-visibility: public
              # Mark Mastodon status as sensitive content
              sensitive: false
              # This is your instance address
              api-endpoint: https://mastodon.social
              # This is the secret you created earlier
              api-token: ${{ secrets.MASTODON_ACCESS_TOKEN }}
              # This is a path to the cache file, using the above cache path
              cache-file: ${{ github.workspace }}/mastofeedbot/cache.json
              # The maximum number of posts created on the first run
              initial-post-limit: 10
    ```

5. Commit and publish your changes.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `rss-feed` | ✅ | | RSS/ATOM feed URL |
| `api-endpoint` | ✅ | | Mastodon instance URL (e.g. `https://mastodon.social`) |
| `api-token` | ✅ | | Mastodon access token |
| `cache-file` | ✅ | | Path to the cache file |
| `template` | | `{{item.title}} {{item.link}}` | [Handlebars](https://handlebarsjs.com/) template for the posted status |
| `status-visibility` | | `public` | Visibility of the posted status (`public` \| `unlisted` \| `private` \| `direct`) |
| `sensitive` | | `false` | Mark Mastodon status as sensitive content |
| `dry-run` | | `false` | Fetch feed and update cache but skip posting to Mastodon |
| `cache-limit` | | `100` | Maximum number of items to keep in the cache |
| `initial-post-limit` | | unlimited | Maximum number of posts created on the first run (when no cache file exists) |
| `post-limit` | | unlimited | Maximum number of posts created per run |
| `xml-entity-expansion-limit` | | `10000` | Maximum number of entity expansions allowed when parsing the RSS feed XML. Set to `0` to disable entity expansion processing entirely. |

## Status template

The status template (`template`) is using [Handlebars](https://handlebarsjs.com/) as template engine.

The action passes the feed metadata as `feedData` (type `FeedData`) and the current entry as `item` (type `FeedEntry`) into the template:

```typescript
export interface FeedEntry {
  id: string;
  link?: string;
  title?: string;
  description?: string;
  published?: string; // ISO 8601 date string
}

export interface FeedData {
  link?: string;
  title?: string;
  description?: string;
  generator?: string;
  language?: string;
  published?: string; // ISO 8601 date string
  entries?: Array<FeedEntry>;
}
```
