import type { Data, DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import { parseDate } from '@/utils/parse-date';

import { runOpenCli } from './utils';

const cacheTtl = 2 * 60 * 60;

interface InstagramPost {
    user: string;
    caption: string;
    url: string;
    date?: string;
    type?: string;
    images?: string[];
    media?: Array<{ type: 'image' | 'video'; url: string; poster?: string }>;
}

function escapeHtml(text: string): string {
    return text.replaceAll(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function parsePosts(data: unknown): InstagramPost[] {
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('opencli instagram feed returned no post array; check the Instagram login and Browser Bridge connection');
    }
    return data.map((post: unknown) => {
        if (!post || typeof post !== 'object' || !('user' in post) || typeof post.user !== 'string' || !post.user || !('caption' in post) || typeof post.caption !== 'string' || !('url' in post) || typeof post.url !== 'string') {
            throw new TypeError('opencli instagram feed returned a malformed post');
        }
        const url = new URL(post.url);
        if (url.protocol !== 'https:' || url.hostname !== 'www.instagram.com' || !/^\/(?:p|reel)\/[^/]+\/$/.test(url.pathname)) {
            throw new TypeError('opencli instagram feed returned an invalid Instagram post URL');
        }
        if ('images' in post && (!Array.isArray(post.images) || post.images.some((image: unknown) => typeof image !== 'string' || !/^https?:\/\//.test(image)))) {
            throw new TypeError('opencli instagram feed returned malformed image URLs');
        }
        if (
            'media' in post &&
            (!Array.isArray(post.media) ||
                post.media.some((item: unknown) => {
                    if (!item || typeof item !== 'object' || !('type' in item) || !['image', 'video'].includes(String(item.type)) || !('url' in item) || typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) {
                        return true;
                    }
                    return 'poster' in item && (typeof item.poster !== 'string' || !/^https?:\/\//.test(item.poster));
                }))
        ) {
            throw new TypeError('opencli instagram feed returned malformed media URLs');
        }
        return { ...post, url: url.origin + url.pathname } as InstagramPost;
    });
}

async function handler(): Promise<Data> {
    const posts = await cache.tryGet(
        'opencli:instagram:home-feed:media-v3-no-ads',
        async () => {
            const data = await runOpenCli(['instagram', 'feed', '--limit', '50', '-f', 'json'], {
                env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: '180' },
                timeout: 240000,
            });
            return parsePosts(data);
        },
        cacheTtl
    );

    const seen = new Set<string>();
    const items: DataItem[] = [];
    for (const post of posts as InstagramPost[]) {
        if (seen.has(post.url)) {
            continue;
        }
        seen.add(post.url);
        const media = post.media || (post.images || []).map((url) => ({ type: 'image' as const, url }));
        const mediaHtml = media
            .map((entry, index) => {
                if (entry.type === 'video') {
                    const poster = entry.poster ? ` poster="${escapeHtml(entry.poster)}"` : '';
                    const videoUrl = escapeHtml(entry.url);
                    return `<p><video controls preload="metadata"${poster}><source src="${videoUrl}" type="video/mp4"></video><br><a href="${videoUrl}">Watch video</a></p>`;
                }
                return `<p><img src="${escapeHtml(entry.url)}" alt="Image ${index + 1}"></p>`;
            })
            .join('');
        const item: DataItem = {
            title: post.caption ? `@${post.user}: ${post.caption}` : `@${post.user} posted on Instagram`,
            author: post.user,
            description: (post.caption ? `<p>${escapeHtml(post.caption)}</p>` : '') + mediaHtml,
            link: post.url,
            guid: post.url,
        };
        if (post.images?.length) {
            item.image = post.images[0];
        }
        const firstVideo = media.find((entry) => entry.type === 'video');
        if (firstVideo) {
            item.enclosure_url = firstVideo.url;
            item.enclosure_type = 'video/mp4';
        }
        if (typeof post.date === 'string' && post.date) {
            const date = parseDate(post.date);
            if (!Number.isNaN(date.getTime())) {
                item.pubDate = date;
            }
        }
        items.push(item);
    }
    return {
        title: 'Instagram · Home Feed',
        description: 'Your logged-in Instagram homepage via OpenCLI, including recommendations with Instagram-marked sponsored posts filtered out',
        link: 'https://www.instagram.com/',
        item: items,
        allowEmpty: false,
    };
}

export const route: Route = {
    path: '/instagram/feed',
    name: 'Instagram Home Feed',
    description: `Reads the logged-in Instagram homepage through the local OpenCLI Browser Bridge. Requires Chrome signed into Instagram and an OpenCLI installation with the \`instagram feed\` command on PATH (or configured through \`OPENCLI_BIN\`).

Includes the visible caption preview, author, post link, and publication time when available. Carousel photos and embedded HTML5 videos are displayed in original publication order, using the largest available rendition. Videos include a cover image, a direct playback link, and the first video is also exposed as an RSS enclosure for compatible readers. Instagram-marked sponsored posts are filtered out; organic recommendations and ordinary brand posts remain. This is not a following-only timeline. Up to 50 non-ad posts are fetched and cached for two hours. Use RSSHub's common \`limit\` parameter to reduce the number of entries.`,
    categories: ['social-media'],
    example: '/opencli/instagram/feed',
    features: { requireConfig: false },
    radar: [{ source: ['www.instagram.com/'], target: '/instagram/feed' }],
    maintainers: ['xiangzy1'],
    handler,
    url: 'www.instagram.com/',
};
