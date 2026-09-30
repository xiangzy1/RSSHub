import MarkdownIt from 'markdown-it';

import type { Data, DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';

import { runOpenCli } from './utils';

const md = MarkdownIt({ html: false, breaks: true, linkify: true });

// 30 minutes, in seconds (the unit cache.tryGet expects).
const CACHE_TTL = 30 * 60;

interface OpenCliCard {
    title?: string;
    description?: string;
    image_url?: string;
    url?: string;
}

interface OpenCliArticle {
    title?: string;
    url?: string;
    cover_image?: string;
    // Filled in by the route (not opencli) after fetching the full article.
    content?: string;
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
    // Pure retweets are unwrapped by opencli: the item IS the original tweet;
    // these two fields record who reposted it.
    is_retweet?: boolean;
    retweeted_by?: string;
    // X Article (long-form) preview; `content` is fetched separately below.
    article?: OpenCliArticle | null;
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
    const text = (quoted.text || '').replaceAll('\n', '<br>');
    const link = quoted.url ? `<br><a href="${quoted.url}">${quoted.url}</a>` : '';
    return `<blockquote>${author}${text}${link}</blockquote>`;
}

function renderCardHtml(card: OpenCliCard): string {
    const image = card.image_url ? `<img src="${card.image_url}" ${MEDIA_SIZE_ATTRS}>` : '';
    const title = card.url ? `<a href="${card.url}">${card.title || card.url}</a>` : card.title || '';
    const description = card.description ? `<br><small>${card.description}</small>` : '';
    return `<div>${image}<br>${title}${description}</div>`;
}

function escapeHtml(s: string): string {
    return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// X Articles ship only a t.co link in the timeline payload, so the full content
// is fetched with a second opencli call (`twitter article <id>`), which returns
// the article as Markdown. Failure is non-fatal: the feed falls back to the
// title + cover preview that the timeline itself provides. A single retry
// covers transient failures right after a cold browser start — the result is
// cached, so a degraded title-only render would otherwise stick for 30 minutes.
async function fetchArticleContent(tweetId: string): Promise<string | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            // Retries must be sequential: the second attempt only makes sense
            // after the first failed, and opencli serialises browser commands.
            // eslint-disable-next-line no-await-in-loop
            const parsed = await runOpenCli(['twitter', 'article', tweetId, '-f', 'json'], { timeout: 90000 });
            const row = (Array.isArray(parsed) ? parsed[0] : parsed) as { content?: string } | undefined;
            const content = row?.content;
            if (typeof content === 'string' && content.trim()) {
                return content;
            }
        } catch (error: unknown) {
            const detail = (error as Error)?.message || String(error);
            logger.warn(`opencli twitter article ${tweetId} attempt ${attempt} failed: ${detail.slice(0, 200)}`);
        }
        if (attempt < 2) {
            // eslint-disable-next-line no-await-in-loop -- backoff between attempts
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }
    return null;
}

function renderArticleHtml(article: OpenCliArticle): string {
    const cover = article.cover_image ? `<img src="${article.cover_image}" ${MEDIA_SIZE_ATTRS}>` : '';
    const heading = `<h3>${escapeHtml(article.title || 'Article')}</h3>`;
    const body = article.content ? md.render(article.content) : article.url ? `<p><a href="${article.url}">Read on x.com</a></p>` : '';
    return `<div>${cover ? cover + '<br>' : ''}${heading}${body}</div>`;
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
            const parsed = await runOpenCli(['twitter', 'timeline', '--type', 'following', '--limit', '50', '-f', 'json'], {
                // First call may boot the opencli daemon + browser; give it room.
                timeout: 120000,
            });
            if (!Array.isArray(parsed)) {
                throw new TypeError(`opencli returned ${typeof parsed}, expected an array`);
            }
            const tweets = parsed as OpenCliTweet[];
            // Article tweets carry only a t.co link in the timeline payload;
            // pull the full content for each one (usually 0-3 per page).
            const articleTweets = tweets.filter((t) => t.article?.title && t.id).slice(0, 10);
            for (const tweet of articleTweets) {
                // One browser command at a time: opencli drives a single Chrome
                // session, so parallel article fetches would queue behind the
                // same lock and only add contention.
                // eslint-disable-next-line no-await-in-loop
                tweet.article!.content = (await fetchArticleContent(tweet.id!)) || undefined;
            }
            return tweets;
        },
        CACHE_TTL
    );

    const items: DataItem[] = (data as OpenCliTweet[]).map((v) => {
        const text = v.text || '';
        // A tweet whose text is only a URL (link posts, X Articles) has no
        // readable title of its own — prefer the article / link-card title.
        const isBareLink = /^https?:\/\/\S+$/.test(text.trim());
        const title = v.article?.title || (isBareLink && v.card?.title ? v.card.title : text.replaceAll('\n', ' '));
        const mediaHtml = renderMediaHtml(v.media_urls || [], v.media_posters || []);
        const quoteHtml = v.quoted_tweet ? renderQuoteHtml(v.quoted_tweet) : '';
        const cardHtml = v.card ? renderCardHtml(v.card) : '';
        const articleHtml = v.article ? renderArticleHtml(v.article) : '';
        const repostHtml = v.is_retweet && v.retweeted_by ? `<p><small>🔁 reposted by @${v.retweeted_by}</small></p>` : '';

        const item: DataItem = {
            title,
            link: v.url,
            guid: v.url,
            // Display name (nickname); falls back to the @handle.
            author: v.name || v.author,
            description: repostHtml + (v.article || (isBareLink && cardHtml) ? '' : text.replaceAll('\n', '<br>')) + (mediaHtml ? `<br>${mediaHtml}` : '') + quoteHtml + cardHtml + articleHtml,
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
