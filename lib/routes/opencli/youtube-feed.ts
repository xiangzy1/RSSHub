import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Data, DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import { parseRelativeDate } from '@/utils/parse-date';

const execFileAsync = promisify(execFile);

// Override the opencli binary path when the RSSHub process PATH does not
// include the nvm global bin (e.g. when launched by systemd/pm2). Set
// OPENCLI_BIN=/absolute/path/to/opencli in that environment.
const OPENCLI_BIN = process.env.OPENCLI_BIN || 'opencli';

// 2 hours, in seconds (the unit cache.tryGet expects).
const CACHE_TTL = 2 * 60 * 60;

export const route: Route = {
    path: '/youtube/subscriptions',
    name: 'YouTube Subscriptions (via OpenCLI)',
    description: `Fetches your YouTube subscriptions feed (videos from channels you follow) by driving a locally installed [\`opencli\`](https://github.com/jackwener/opencli), which reuses your logged-in Chrome session — no YouTube Data API key required.

Requires:

- \`opencli\` installed and on PATH (or the \`OPENCLI_BIN\` env var set to its absolute path)
- Chrome running and signed into YouTube (managed by opencli / Browser Bridge)`,
    categories: ['other'],
    example: '/opencli/youtube/subscriptions',
    features: {
        requireConfig: false,
    },
    radar: [
        {
            source: ['www.youtube.com/feed/subscriptions'],
            target: '/youtube/subscriptions',
        },
    ],
    maintainers: ['xiangzy1'],
    handler,
    url: 'www.youtube.com/feed/subscriptions',
};

async function handler(): Promise<Data> {
    // opencli drives a real browser; results are cached 2h to avoid hammering
    // YouTube and to keep the response fast. The cached value is the parsed
    // JSON array straight from `opencli ... -f json`.
    const data = await cache.tryGet(
        'opencli:youtube:subscriptions',
        async () => {
            let stdout: string;
            try {
                const result = await execFileAsync(OPENCLI_BIN, ['youtube', 'feed', '--type', 'subscribed', '--limit', '50', '-f', 'json'], {
                    // 50 videos of JSON can exceed the default 1MB buffer.
                    maxBuffer: 10 * 1024 * 1024,
                    // First call may boot the opencli daemon + browser; give it room.
                    timeout: 120000,
                });
                stdout = result.stdout;
            } catch (error: unknown) {
                const e = error as { stderr?: string; message?: string };
                const detail = (e.stderr || e.message || String(error)).trim();
                throw new Error(`opencli failed: ${detail || 'unknown error'}`, { cause: error });
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(stdout);
            } catch (error) {
                throw new Error(`opencli returned non-JSON output (first 200 chars): ${stdout.slice(0, 200)}`, { cause: error });
            }
            if (!Array.isArray(parsed)) {
                throw new TypeError(`opencli returned ${typeof parsed}, expected an array`);
            }
            return parsed;
        },
        CACHE_TTL
    );

    const items: DataItem[] = (data as Array<Record<string, string>>).map((v) => {
        const thumbnail = v.thumbnail || (v.video_id ? `https://i.ytimg.com/vi/${v.video_id}/hqdefault.jpg` : undefined);
        const descriptionParts = [v.channel, v.views, v.duration].filter(Boolean).join(' · ');

        const item: DataItem = {
            title: v.title || '(untitled)',
            link: v.url,
            guid: v.url,
            author: v.channel,
            description: (thumbnail ? `<img src="${thumbnail}"><br>` : '') + descriptionParts,
        };

        // published is a locale-relative string ("14 hours ago" / "14小时前").
        // parseRelativeDate handles both; fall back to omitting pubDate when it
        // can't parse (e.g. "Live" or empty) — readers then use fetch time.
        const published = v.published;
        if (published) {
            const parsed = parseRelativeDate(published);
            if (!Number.isNaN(parsed.getTime())) {
                item.pubDate = parsed;
            }
        }

        if (thumbnail) {
            item.image = thumbnail;
        }

        return item;
    });

    return {
        title: 'YouTube · Subscriptions',
        description: 'YouTube subscriptions feed via OpenCLI (requires local opencli + a Chrome session signed into YouTube)',
        link: 'https://www.youtube.com/feed/subscriptions',
        item: items,
        allowEmpty: false,
    };
}
