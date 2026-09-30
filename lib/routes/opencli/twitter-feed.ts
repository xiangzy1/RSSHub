import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Data, DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import { parseDate } from '@/utils/parse-date';

const execFileAsync = promisify(execFile);

// Override the opencli binary path when the RSSHub process PATH does not
// include the nvm global bin (e.g. when launched by systemd/pm2). Set
// OPENCLI_BIN=/absolute/path/to/opencli in that environment.
const OPENCLI_BIN = process.env.OPENCLI_BIN || 'opencli';

// 30 minutes, in seconds (the unit cache.tryGet expects).
const CACHE_TTL = 30 * 60;

interface OpenCliCard {
    title?: string;
    description?: string;
    image_url?: string;
    url?: string;
}

interface OpenCliTweet {
    id?: string;
    author?: string;
    name?: string;
    text?: string;
    created_at?: string;
    url?: string;
    media_urls?: string[];
    media_posters?: string[];
    card?: OpenCliCard | null;
    quoted_tweet?: OpenCliTweet | null;
}

// Cap media width so images/videos don't render wider than the text column
// in RSS readers. max-width handles style-aware readers; the width attribute
// is the fallback for readers that strip inline styles.
const MEDIA_SIZE_ATTRS = 'width="680" style="max-width:100%"';

function renderMediaHtml(mediaUrls: string[], mediaPosters: string[]): string {
    return mediaUrls
        .map((mediaUrl, i) => {
            const poster = mediaPosters[i] || mediaUrl;
            if (/video\.twimg\.com/.test(mediaUrl) || mediaUrl.endsWith('.mp4')) {
                return `<video src="${mediaUrl}" poster="${poster}" controls preload="metadata" ${MEDIA_SIZE_ATTRS}></video>`;
            }
            return `<img src="${mediaUrl}" ${MEDIA_SIZE_ATTRS}>`;
        })
        .join('');
}

function renderQuoteHtml(quoted: OpenCliTweet): string {
    const author = quoted.name || quoted.author ? `${quoted.name || quoted.author}: ` : '';
    const text = (quoted.text || '').replaceAll(/\n/g, '<br>');
    const link = quoted.url ? `<br><a href="${quoted.url}">${quoted.url}</a>` : '';
    return `<blockquote>${author}${text}${link}</blockquote>`;
}

function renderCardHtml(card: OpenCliCard): string {
    const image = card.image_url ? `<img src="${card.image_url}" ${MEDIA_SIZE_ATTRS}>` : '';
    const title = card.url ? `<a href="${card.url}">${card.title || card.url}</a>` : card.title || '';
    const description = card.description ? `<br><small>${card.description}</small>` : '';
    return `<div>${image}<br>${title}${description}</div>`;
}

export const route: Route = {
    path: '/twitter/following',
    name: 'Twitter Following Timeline (via OpenCLI)',
    description: `Tweets from the accounts you follow (the chronological "Following" timeline on x.com), by driving a locally installed [\`opencli\`](https://github.com/jackwener/opencli), which reuses your logged-in Chrome session — no API key or cookie env var needed.

Requires:

- \`opencli\` installed and on PATH (or the \`OPENCLI_BIN\` env var set to its absolute path)
- Chrome running and signed into x.com (managed by opencli / Browser Bridge)`,
    categories: ['other'],
    example: '/opencli/twitter/following',
    features: {
        requireConfig: false,
    },
    radar: [
        {
            source: ['x.com/home', 'twitter.com/home'],
            target: '/twitter/following',
        },
    ],
    maintainers: ['xiangzy1'],
    handler,
    url: 'x.com/home',
};

async function handler(): Promise<Data> {
    // opencli drives a real browser; results are cached to avoid hammering
    // x.com and to keep the response fast. The cached value is the parsed
    // JSON array straight from `opencli ... -f json`.
    const data = await cache.tryGet(
        'opencli:twitter:following-timeline',
        async () => {
            let stdout: string;
            try {
                const result = await execFileAsync(OPENCLI_BIN, ['twitter', 'timeline', '--type', 'following', '--limit', '50', '-f', 'json'], {
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

    const items: DataItem[] = (data as OpenCliTweet[]).map((v) => {
        const text = v.text || '';
        const title = text.replaceAll(/\n/g, ' ');
        const mediaHtml = renderMediaHtml(v.media_urls || [], v.media_posters || []);
        const quoteHtml = v.quoted_tweet ? renderQuoteHtml(v.quoted_tweet) : '';
        const cardHtml = v.card ? renderCardHtml(v.card) : '';

        const item: DataItem = {
            title,
            link: v.url,
            guid: v.url,
            // Display name (nickname); falls back to the @handle.
            author: v.name || v.author,
            description: text.replaceAll(/\n/g, '<br>') + (mediaHtml ? `<br>${mediaHtml}` : '') + quoteHtml + cardHtml,
        };

        // Hashtags are the closest thing to tags on tweets.
        const categories = [...new Set(text.match(/#([^\s<]+)/g)?.map((m) => m.slice(1)) || [])];
        if (categories.length > 0) {
            item.category = categories;
        }

        const firstImage = v.media_posters?.[0];
        if (firstImage) {
            item.image = firstImage;
        }

        // created_at is Twitter's absolute format ("Tue Sep 29 09:02:37 +0000 2026").
        if (v.created_at) {
            const parsed = parseDate(v.created_at);
            if (!Number.isNaN(parsed.getTime())) {
                item.pubDate = parsed;
            }
        }

        return item;
    });

    return {
        title: 'Twitter · Following Timeline',
        description: 'Tweets from the accounts you follow, via OpenCLI (requires local opencli + a Chrome session signed into x.com)',
        link: 'https://x.com/home',
        item: items,
        allowEmpty: false,
    };
}
