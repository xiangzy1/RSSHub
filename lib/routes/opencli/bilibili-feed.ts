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

// 30 minutes, in seconds (the unit cache.tryGet expects).
const CACHE_TTL = 30 * 60;

export const route: Route = {
    path: '/bilibili/feed',
    name: 'Bilibili Followings Feed (via OpenCLI)',
    description: `Dynamics from the bilibili users you follow, by driving a locally installed [\`opencli\`](https://github.com/jackwener/opencli), which reuses your logged-in Chrome session — no cookie env var needed.

Requires:

- \`opencli\` installed and on PATH (or the \`OPENCLI_BIN\` env var set to its absolute path)
- Chrome running and signed into bilibili (managed by opencli / Browser Bridge)

Video dynamics link directly to the video page; others link to the dynamic page (\`t.bilibili.com\`).`,
    categories: ['other'],
    example: '/opencli/bilibili/feed',
    features: {
        requireConfig: false,
    },
    maintainers: ['xiangzy1'],
    handler,
};

async function handler(): Promise<Data> {
    // opencli drives a real browser; results are cached to avoid hammering
    // bilibili and to keep the response fast. The cached value is the parsed
    // JSON array straight from `opencli ... -f json`.
    const data = await cache.tryGet(
        'opencli:bilibili:followings-feed',
        async () => {
            let stdout: string;
            try {
                const result = await execFileAsync(OPENCLI_BIN, ['bilibili', 'feed', '--limit', '50', '-f', 'json'], {
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

    const items: DataItem[] = (data as Array<Record<string, string | number>>).map((v) => {
        const title = String(v.title || '(untitled)');
        const url = String(v.url || '');
        const type = String(v.type || '');
        const likes = Number(v.likes ?? 0);
        const descriptionParts = [v.author, type, `${likes} likes`].filter(Boolean).join(' · ');

        // opencli strips HTML from the dynamic body; re-escape before embedding
        // it in the description and turn newlines into <br> for RSS readers.
        const content = String(v.content || '').trim();
        const contentHTML = content ? `<br>${content.replaceAll(/&/g, '&amp;').replaceAll(/</g, '&lt;').replaceAll(/>/g, '&gt;').replaceAll(/\n/g, '<br>')}` : '';

        // Images come newline-separated from opencli. Some readers only allow
        // https content, and hdslb serves both, so upgrade the protocol.
        const images = String(v.images || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((u) => u.replace(/^http:\/\//, 'https://'));
        // Cap image width so pictures don't render wider than the text column
        // in RSS readers; the width attribute covers readers that strip styles.
        const imageHTML = images.map((u) => `<img src="${u}" width="680" style="max-width:100%">`).join('');

        const item: DataItem = {
            title,
            link: url,
            guid: url,
            author: v.author ? String(v.author) : undefined,
            description: descriptionParts + contentHTML + (imageHTML ? `<br>${imageHTML}` : ''),
        };

        if (images.length > 0) {
            item.image = images[0];
        }

        // time is a locale-relative string ("5分钟前" / "5 minutes ago").
        // parseRelativeDate handles both; fall back to omitting pubDate when it
        // can't parse — readers then use fetch time.
        const time = v.time ? String(v.time) : '';
        if (time) {
            const parsed = parseRelativeDate(time);
            if (!Number.isNaN(parsed.getTime())) {
                item.pubDate = parsed;
            }
        }

        return item;
    });

    return {
        title: 'Bilibili · Followings Feed',
        description: 'Dynamics from bilibili users you follow, via OpenCLI (requires local opencli + a Chrome session signed into bilibili)',
        link: 'https://www.bilibili.com/',
        item: items,
        allowEmpty: false,
    };
}
