import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { route as bilibiliRoute } from '../lib/routes/opencli/bilibili-feed';
import { route as twitterRoute } from '../lib/routes/opencli/twitter-feed';
import { route as youtubeRoute } from '../lib/routes/opencli/youtube-feed';
import type { Data } from '../lib/types';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), tryGet: vi.fn() }));
vi.mock('node:child_process', () => {
    const execFile = vi.fn();
    Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: mocks.execFile });
    return { execFile };
});
vi.mock('../lib/utils/cache', () => ({ default: { tryGet: mocks.tryGet } }));

const envelope = (data: unknown) => JSON.stringify({ ok: true, data });
const invoke = async (route: typeof bilibiliRoute) => (await route.handler({} as Context)) as Data;

beforeEach(() => {
    vi.resetAllMocks();
    mocks.tryGet.mockImplementation(async (_key, callback) => await callback());
});

describe('OpenCLI routes with the 2.x JSON envelope', () => {
    it('unwraps bilibili rows and prefers pub_ts over the relative time string', async () => {
        mocks.execFile.mockResolvedValue({
            stdout: envelope([
                {
                    title: 'A video',
                    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
                    type: 'video',
                    likes: 3,
                    author: 'up',
                    content: 'hello <world>',
                    images: 'http://i0.hdslb.com/a.jpg\nhttps://i0.hdslb.com/b.jpg',
                    time: '5分钟前',
                    pub_ts: 1_792_400_417,
                },
            ]),
        });

        const feed = await invoke(bilibiliRoute);
        expect(feed.item).toHaveLength(1);
        expect(feed.item[0].pubDate).toEqual(new Date(1_792_400_417 * 1000));
        expect(feed.item[0].image).toBe('https://i0.hdslb.com/a.jpg');
        expect(feed.item[0].description).toContain('hello &lt;world&gt;');
        expect(feed.item[0].description).toContain('https://i0.hdslb.com/b.jpg');
    });

    it('unwraps youtube rows and keeps the thumbnail', async () => {
        mocks.execFile.mockResolvedValue({
            stdout: envelope([
                {
                    title: 'A video',
                    channel: 'A channel',
                    views: '1K views',
                    duration: '3:00',
                    published: '2 hours ago',
                    url: 'https://www.youtube.com/watch?v=abc',
                    video_id: 'abc',
                    thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
                },
            ]),
        });

        const feed = await invoke(youtubeRoute);
        expect(feed.item).toHaveLength(1);
        expect(feed.item[0].title).toBe('A video');
        expect(feed.item[0].image).toBe('https://i.ytimg.com/vi/abc/hqdefault.jpg');
        expect(feed.item[0].description).toContain('A channel · 1K views · 3:00');
    });

    it('unwraps timeline and article payloads', async () => {
        mocks.execFile
            .mockResolvedValueOnce({
                stdout: envelope([
                    {
                        id: '1',
                        author: 'alice',
                        name: 'Alice',
                        text: 'hello #tag',
                        created_at: 'Tue Sep 29 09:02:37 +0000 2026',
                        url: 'https://x.com/alice/status/1',
                        is_retweet: true,
                        retweeted_by: 'bob',
                    },
                    {
                        id: '2',
                        author: 'alice',
                        name: 'Alice',
                        text: 'https://t.co/article',
                        created_at: 'Tue Sep 29 09:02:37 +0000 2026',
                        url: 'https://x.com/alice/status/2',
                        article: { title: 'Long read', url: 'https://x.com/i/article/9' },
                    },
                ]),
            })
            .mockResolvedValueOnce({ stdout: envelope([{ content: '# Heading' }]) });

        const feed = await invoke(twitterRoute);
        expect(mocks.execFile).toHaveBeenLastCalledWith(expect.any(String), ['twitter', 'article', '2', '-f', 'json'], expect.objectContaining({ timeout: 90000 }));
        expect(feed.item).toHaveLength(2);
        expect(feed.item[0].author).toBe('Alice');
        expect(feed.item[0].category).toEqual(['tag']);
        expect(feed.item[0].description).toContain('reposted by @bob');
        expect(feed.item[1].title).toBe('Long read');
        expect(feed.item[1].description).toContain('<h1>Heading</h1>');
    });

    it('surfaces the failure envelope printed on stdout', async () => {
        mocks.execFile.mockRejectedValue({
            stdout: JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Login required', hint: 'Sign in first' } }),
            stderr: '',
        });

        await expect(invoke(bilibiliRoute)).rejects.toThrow('opencli bilibili feed failed: Login required (Sign in first)');
    });
});
