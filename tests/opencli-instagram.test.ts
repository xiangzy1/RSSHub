import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { route } from '../lib/routes/opencli/instagram-feed';
import type { Data } from '../lib/types';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), tryGet: vi.fn() }));
vi.mock('node:child_process', () => {
    const execFile = vi.fn();
    Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: mocks.execFile });
    return { execFile };
});
vi.mock('../lib/utils/cache', () => ({ default: { tryGet: mocks.tryGet } }));

const invoke = async () => (await route.handler({} as Context)) as Data;
const post = { user: 'alice', caption: 'Hello <world> & friends', url: 'https://www.instagram.com/p/ABC/', date: '2026-10-04T05:52:36.000Z' };
// opencli 2.x wraps every JSON result in an {ok,data} envelope.
const envelope = (data: unknown) => JSON.stringify({ ok: true, data });

beforeEach(() => {
    vi.resetAllMocks();
    mocks.tryGet.mockImplementation(async (_key, callback) => await callback());
    mocks.execFile.mockResolvedValue({ stdout: envelope([post]) });
});

describe('OpenCLI Instagram RSS feed', () => {
    it('uses the local command and caches successful posts for two hours', async () => {
        const feed = await invoke();
        expect(mocks.execFile).toHaveBeenCalledExactlyOnceWith(expect.any(String), ['instagram', 'feed', '--limit', '50', '-f', 'json'], {
            timeout: 240000,
            maxBuffer: 10 * 1024 * 1024,
            env: expect.objectContaining({ OPENCLI_BROWSER_COMMAND_TIMEOUT: '180' }),
        });
        expect(mocks.tryGet).toHaveBeenCalledWith('opencli:instagram:home-feed:media-v3-no-ads', expect.any(Function), 7200);
        expect(feed.item).toEqual([
            {
                title: '@alice: Hello <world> & friends',
                author: 'alice',
                description: '<p>Hello &lt;world&gt; &amp; friends</p>',
                link: post.url,
                guid: post.url,
                pubDate: new Date(post.date),
            },
        ]);
        expect(feed.allowEmpty).toBe(false);
    });

    it('still accepts the bare array printed by opencli 1.x', async () => {
        mocks.execFile.mockResolvedValue({ stdout: JSON.stringify([post]) });
        expect((await invoke()).item).toHaveLength(1);
    });

    it('uses cached data without executing another browser command', async () => {
        mocks.tryGet.mockResolvedValueOnce([post]);
        expect((await invoke()).item).toHaveLength(1);
        expect(mocks.execFile).not.toHaveBeenCalled();
    });

    it('deduplicates stable URLs and keeps full captions and titles', async () => {
        const caption = 'A long caption '.repeat(30);
        mocks.execFile.mockResolvedValue({
            stdout: envelope([
                { ...post, caption, url: post.url + '?source=home' },
                { ...post, caption },
            ]),
        });
        const feed = await invoke();
        expect(feed.item).toHaveLength(1);
        expect(feed.item[0].title).toBe(`@alice: ${caption}`);
        expect(feed.item[0].link).toBe(post.url);
    });

    it('omits missing or invalid dates instead of inventing fetch time', async () => {
        mocks.execFile.mockResolvedValue({
            stdout: envelope([
                { ...post, date: '', caption: '' },
                { ...post, url: 'https://www.instagram.com/reel/DEF/', date: 'invalid' },
            ]),
        });
        const feed = await invoke();
        expect(feed.item.map((item) => item.pubDate)).toEqual([undefined, undefined]);
        expect(feed.item[0].title).toBe('@alice posted on Instagram');
        expect(feed.item[0].description).toBe('');
    });

    it.each(['not JSON', '{}', envelope([]), envelope([{}]), envelope([{ ...post, url: 'https://example.com/p/ABC/' }])])('fails clearly for invalid command output: %s', async (stdout) => {
        mocks.execFile.mockResolvedValue({ stdout });
        await expect(invoke()).rejects.toThrow(/opencli instagram feed/);
    });

    it('preserves actionable command failure details', async () => {
        mocks.execFile.mockRejectedValue({ stderr: 'Instagram login required' });
        await expect(invoke()).rejects.toThrow('opencli instagram feed failed: Instagram login required');
    });

    it('reads the opencli 2.x failure envelope from stdout', async () => {
        mocks.execFile.mockRejectedValue({
            stdout: JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Instagram login required', hint: 'Sign in to Instagram in Chrome' } }),
            stderr: '',
        });
        await expect(invoke()).rejects.toThrow('opencli instagram feed failed: Instagram login required (Sign in to Instagram in Chrome)');
    });

    it('renders every image in source order, escapes URLs and selects the first as feed thumbnail', async () => {
        const images = ['https://cdn.example.com/first.jpg?x=1&y=2', 'https://cdn.example.com/second.jpg', 'https://cdn.example.com/third.jpg'];
        mocks.execFile.mockResolvedValue({ stdout: envelope([{ ...post, images }]) });
        const item = (await invoke()).item[0];
        expect(item.image).toBe(images[0]);
        expect(item.description).toBe(
            '<p>Hello &lt;world&gt; &amp; friends</p><p><img src="https://cdn.example.com/first.jpg?x=1&amp;y=2" alt="Image 1"></p><p><img src="https://cdn.example.com/second.jpg" alt="Image 2"></p><p><img src="https://cdn.example.com/third.jpg" alt="Image 3"></p>'
        );
    });

    it('keeps image-only posts and repeated image positions', async () => {
        mocks.execFile.mockResolvedValue({ stdout: envelope([{ ...post, caption: '', images: ['https://cdn.example.com/photo.jpg', 'https://cdn.example.com/photo.jpg'] }]) });
        const item = (await invoke()).item[0];
        expect(String(item.description).match(/<img /g)).toHaveLength(2);
    });

    it.each([['javascript:alert(1)'], [123], 'not an array'])('rejects unsafe or malformed images: %s', async (images) => {
        mocks.execFile.mockResolvedValue({ stdout: envelope([{ ...post, images }]) });
        await expect(invoke()).rejects.toThrow('malformed image URLs');
    });

    it('embeds videos between images in original carousel order without repeating the video cover', async () => {
        const media = [
            { type: 'image', url: 'https://cdn.example.com/first.jpg' },
            { type: 'video', url: 'https://cdn.example.com/second.mp4?x=1&y=2', poster: 'https://cdn.example.com/poster.jpg?x=1&y=2' },
            { type: 'image', url: 'https://cdn.example.com/third.jpg' },
            { type: 'video', url: 'https://cdn.example.com/fourth.mp4' },
        ];
        mocks.execFile.mockResolvedValue({ stdout: envelope([{ ...post, images: [media[0].url, media[1].poster, media[2].url], media }]) });
        const item = (await invoke()).item[0];
        const html = String(item.description);
        expect(html).toContain('<video controls preload="metadata" poster="https://cdn.example.com/poster.jpg?x=1&amp;y=2"><source src="https://cdn.example.com/second.mp4?x=1&amp;y=2" type="video/mp4"></video>');
        expect(html).toContain('<a href="https://cdn.example.com/second.mp4?x=1&amp;y=2">Watch video</a>');
        expect(html.indexOf('first.jpg')).toBeLessThan(html.indexOf('second.mp4'));
        expect(html.indexOf('second.mp4')).toBeLessThan(html.indexOf('third.jpg'));
        expect(html.indexOf('third.jpg')).toBeLessThan(html.indexOf('fourth.mp4'));
        expect(html.match(/<img /g)).toHaveLength(2);
        expect(html.match(/<video /g)).toHaveLength(2);
        expect(item.enclosure_url).toBe(media[1].url);
        expect(item.enclosure_type).toBe('video/mp4');
    });

    it.each([[{ type: 'video', url: 'javascript:alert(1)' }], [{ type: 'video', url: 'https://cdn.example.com/video.mp4', poster: 'javascript:alert(1)' }], [{ type: 'unknown', url: 'https://cdn.example.com/file' }]])(
        'rejects malformed video metadata: %s',
        async (media) => {
            mocks.execFile.mockResolvedValue({ stdout: envelope([{ ...post, media }]) });
            await expect(invoke()).rejects.toThrow('malformed media URLs');
        }
    );
});
