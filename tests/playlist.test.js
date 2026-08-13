import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import test from 'node:test';

import worker from '../src/index.js';

const BASE_ENV = {
    AUTH_ENABLED: 'false',
    CACHE_MAX_AGE: '0',
    DEBUG_ALLOW_ALL_REFERERS: 'true',
    DEFAULT_BR: '320',
    LRCTYPE: '0',
    PICSIZE: '300',
};

function jsonUpstreamResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
        },
    });
}

function createRawSong(id) {
    return {
        id,
        name: `Song ${id}`,
        ar: [
            { name: `Artist ${id}` },
            { name: 'Guest' },
        ],
        al: {
            name: `Album ${id}`,
            pic: 700000 + id,
            picUrl: `https://p1.music.126.net/example/${900000 + id}.jpg`,
        },
    };
}

async function requestWorker(url, env = {}) {
    return worker.fetch(
        new Request(url),
        { ...BASE_ENV, ...env },
        { waitUntil() {} }
    );
}

async function withMockFetch(mock, callback) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock;
    try {
        return await callback();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

async function hmacSha256(text, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
    return Array.from(new Uint8Array(signature))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function decryptAes128Ecb(value, key, encoding) {
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key), null);
    return Buffer.concat([
        decipher.update(Buffer.from(value, encoding)),
        decipher.final(),
    ]).toString('utf8');
}

function decodeNeteaseEapiRequest(body, pathname) {
    const encrypted = new URLSearchParams(body).get('params') || '';
    assert.match(encrypted, /^[0-9A-F]+$/);

    const decrypted = decryptAes128Ecb(encrypted, 'e82ckenh8dichen8', 'hex');
    const salt = '36cd479b6b5';
    const prefix = `${pathname}-${salt}-`;
    const digestSeparator = `-${salt}-`;
    assert.ok(decrypted.startsWith(prefix));

    const payloadAndDigest = decrypted.slice(prefix.length);
    const separatorIndex = payloadAndDigest.lastIndexOf(digestSeparator);
    assert.ok(separatorIndex > 0);
    assert.match(payloadAndDigest.slice(separatorIndex + digestSeparator.length), /^[0-9a-f]{32}$/);

    return JSON.parse(payloadAndDigest.slice(0, separatorIndex));
}

test('网易云 playlist 优先采用完整 tracks 的手动顺序', async () => {
    let upstreamCalls = 0;

    await withMockFetch(async (input) => {
        const url = String(input);
        upstreamCalls += 1;
        assert.ok(url.endsWith('/eapi/v6/playlist/detail'));
        return jsonUpstreamResponse({
            code: 200,
            playlist: {
                trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }],
                tracks: [createRawSong(3), createRawSong(1), createRawSong(2)],
            },
        });
    }, async () => {
        const response = await requestWorker(
            'https://worker.example/?server=netease&type=playlist&id=42'
        );
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(upstreamCalls, 1);
        assert.deepEqual(payload.map((song) => song.name), [
            'Song 3',
            'Song 1',
            'Song 2',
        ]);
    });
});

test('网易云 playlist 在 tracks 不完整时补充 trackIds 并按 100 首拆批', async () => {
    const trackIds = [...Array.from({ length: 201 }, (_, index) => index + 1)];
    let detailBatch = 0;

    await withMockFetch(async (input) => {
        const url = String(input);
        if (url.endsWith('/eapi/v6/playlist/detail')) {
            return jsonUpstreamResponse({
                code: 200,
                playlist: {
                    trackIds: trackIds.map((id) => ({ id })),
                    tracks: [createRawSong(201), createRawSong(1)],
                },
            });
        }

        if (url.endsWith('/eapi/v3/song/detail')) {
            detailBatch += 1;
            if (detailBatch === 1) {
                return jsonUpstreamResponse({
                    songs: Array.from({ length: 100 }, (_, index) => createRawSong(101 - index)),
                });
            }
            return jsonUpstreamResponse({
                songs: Array.from({ length: 99 }, (_, index) => createRawSong(200 - index)),
            });
        }

        throw new Error(`Unexpected upstream URL: ${url}`);
    }, async () => {
        const response = await requestWorker(
            'https://worker.example/?server=netease&type=playlist&id=42&br=320'
        );
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(detailBatch, 2);
        assert.equal(payload.length, 201);
        assert.equal(payload[0].name, 'Song 201');
        assert.equal(payload[1].name, 'Song 1');
        assert.equal(payload.at(-1).name, 'Song 200');
        assert.deepEqual(Object.keys(payload[1]), ['name', 'artist', 'album', 'url', 'pic', 'lrc']);
        assert.equal(payload[1].artist, 'Artist 1/Guest');
        assert.equal(payload[1].album, 'Album 1');

        const audioUrl = new URL(payload[1].url);
        assert.equal(audioUrl.searchParams.get('server'), 'netease');
        assert.equal(audioUrl.searchParams.get('type'), 'url');
        assert.equal(audioUrl.searchParams.get('id'), '1');
        assert.equal(audioUrl.searchParams.get('br'), '320');

        const pictureUrl = new URL(payload[1].pic);
        assert.equal(pictureUrl.searchParams.get('type'), 'pic');
        assert.equal(pictureUrl.searchParams.get('id'), '900001');

        const lyricUrl = new URL(payload[1].lrc);
        assert.equal(lyricUrl.searchParams.get('type'), 'lrc');
        assert.equal(lyricUrl.searchParams.get('id'), '1');
    });
});

test('playlist 在鉴权开启时为所有二级链接生成正确签名', async () => {
    const authSecret = 'playlist-test-secret';

    await withMockFetch(async (input) => {
        const url = String(input);
        if (url.endsWith('/eapi/v6/playlist/detail')) {
            return jsonUpstreamResponse({ playlist: { trackIds: [{ id: 123 }] } });
        }
        if (url.endsWith('/eapi/v3/song/detail')) {
            return jsonUpstreamResponse({ songs: [createRawSong(123)] });
        }
        throw new Error(`Unexpected upstream URL: ${url}`);
    }, async () => {
        const response = await requestWorker(
            'https://worker.example/song?server=netease&type=playlist&id=42',
            {
                AUTH_ENABLED: 'true',
                AUTH_SECRET: authSecret,
            }
        );
        const [song] = await response.json();
        const endpoints = [
            [song.url, 'url', '123'],
            [song.pic, 'pic', '900123'],
            [song.lrc, 'lrc', '123'],
        ];

        assert.equal(response.status, 200);
        for (const [value, type, id] of endpoints) {
            const endpoint = new URL(value);
            assert.equal(
                endpoint.searchParams.get('auth'),
                await hmacSha256(`netease${type}${id}`, authSecret)
            );
        }
    });
});

test('空歌单返回 404', async () => {
    await withMockFetch(async (input) => {
        const url = String(input);
        assert.ok(url.endsWith('/eapi/v6/playlist/detail'));
        return jsonUpstreamResponse({ playlist: { trackIds: [] } });
    }, async () => {
        const response = await requestWorker(
            'https://worker.example/?server=netease&type=playlist&id=42'
        );

        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: '网易云歌单不存在或为空' });
    });
});

test('网易云单曲详情和歌词均使用带 NMTID 的 EAPI 请求', async () => {
    const upstreamPaths = [];

    await withMockFetch(async (input, init) => {
        const url = new URL(String(input));
        upstreamPaths.push(url.pathname);
        assert.ok(url.pathname.startsWith('/eapi/'));

        const cookie = new Headers(init?.headers).get('Cookie') || '';
        assert.match(cookie, /(?:^|; )NMTID=00[a-f0-9]{30}(?:;|$)/);

        if (url.pathname === '/eapi/v3/song/detail') {
            return jsonUpstreamResponse({ songs: [createRawSong(123)] });
        }
        if (url.pathname === '/eapi/song/lyric') {
            return jsonUpstreamResponse({
                lrc: { lyric: '[00:00.00]Original' },
                tlyric: { lyric: '[00:00.00]翻译' },
            });
        }
        throw new Error(`Unexpected upstream URL: ${url}`);
    }, async () => {
        const songResponse = await requestWorker(
            'https://worker.example/?server=netease&type=song&id=123'
        );
        const lyricResponse = await requestWorker(
            'https://worker.example/?server=netease&type=lrc&id=123'
        );

        assert.equal(songResponse.status, 200);
        assert.equal((await songResponse.json())[0].title, 'Song 123');
        assert.equal(lyricResponse.status, 200);
        assert.equal(await lyricResponse.text(), '[00:00.00]Original');
        assert.deepEqual(upstreamPaths, [
            '/eapi/v3/song/detail',
            '/eapi/song/lyric',
        ]);
    });
});

test('playlist 拒绝 QQ 音乐和非数字网易云歌单 ID', async () => {
    await withMockFetch(async () => {
        throw new Error('不应请求上游');
    }, async () => {
        const tencentResponse = await requestWorker(
            'https://worker.example/?server=tencent&type=playlist&id=42'
        );
        assert.equal(tencentResponse.status, 400);
        assert.deepEqual(await tencentResponse.json(), {
            error: 'playlist 目前仅支持网易云音乐',
        });

        const invalidIdResponse = await requestWorker(
            'https://worker.example/?server=netease&type=playlist&id=12abc'
        );
        assert.equal(invalidIdResponse.status, 400);
        assert.deepEqual(await invalidIdResponse.json(), {
            error: '网易云歌单 ID 必须是数字',
        });
    });
});

test('网易云 album 使用 MusicBot-Go 专辑 EAPI 并返回标准歌曲数组', async () => {
    const authSecret = 'album-test-secret';
    let upstreamCalls = 0;

    await withMockFetch(async (input, init) => {
        const url = new URL(String(input));
        upstreamCalls += 1;

        assert.equal(url.pathname, '/eapi/album/v3/detail');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/x-www-form-urlencoded');
        assert.match(new Headers(init?.headers).get('Cookie') || '', /(?:^|; )NMTID=00[a-f0-9]{30}(?:;|$)/);

        const body = decodeNeteaseEapiRequest(init?.body || '', '/api/album/v3/detail');
        assert.equal(body.id, 3411281);
        assert.equal(
            decryptAes128Ecb(body.cache_key, ')(13daqP@ssw0rd~', 'base64'),
            'id=3411281'
        );

        return jsonUpstreamResponse({
            code: 200,
            album: { id: 3411281, name: 'Example Album' },
            songs: [createRawSong(3), createRawSong(1)],
        });
    }, async () => {
        const response = await requestWorker(
            'https://worker.example/song?server=netease&type=album&id=3411281&br=320',
            {
                AUTH_ENABLED: 'true',
                AUTH_SECRET: authSecret,
            }
        );
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(upstreamCalls, 1);
        assert.deepEqual(payload.map((song) => song.name), ['Song 3', 'Song 1']);
        assert.deepEqual(Object.keys(payload[0]), ['name', 'artist', 'album', 'url', 'pic', 'lrc']);
        assert.equal(payload[0].artist, 'Artist 3/Guest');
        assert.equal(payload[0].album, 'Album 3');

        const endpoints = [
            [payload[0].url, 'url', '3'],
            [payload[0].pic, 'pic', '900003'],
            [payload[0].lrc, 'lrc', '3'],
        ];
        for (const [value, type, id] of endpoints) {
            const endpoint = new URL(value);
            assert.equal(endpoint.pathname, '/song');
            assert.equal(endpoint.searchParams.get('server'), 'netease');
            assert.equal(endpoint.searchParams.get('type'), type);
            assert.equal(endpoint.searchParams.get('id'), id);
            assert.equal(
                endpoint.searchParams.get('auth'),
                await hmacSha256(`netease${type}${id}`, authSecret)
            );
        }
        assert.equal(new URL(payload[0].url).searchParams.get('br'), '320');
    });
});

test('album 校验音乐源和专辑 ID，并区分缺失参数', async () => {
    await withMockFetch(async () => {
        throw new Error('不应请求上游');
    }, async () => {
        const missingIdResponse = await requestWorker(
            'https://worker.example/?server=netease&type=album'
        );
        assert.equal(missingIdResponse.status, 400);
        assert.deepEqual(await missingIdResponse.json(), { error: '缺少专辑 ID' });

        const tencentResponse = await requestWorker(
            'https://worker.example/?server=tencent&type=album&id=3411281'
        );
        assert.equal(tencentResponse.status, 400);
        assert.deepEqual(await tencentResponse.json(), {
            error: 'album 目前仅支持网易云音乐',
        });

        const invalidIdResponse = await requestWorker(
            'https://worker.example/?server=netease&type=album&id=12abc'
        );
        assert.equal(invalidIdResponse.status, 400);
        assert.deepEqual(await invalidIdResponse.json(), {
            error: '网易云专辑 ID 必须是数字',
        });
    });
});

test('网易云不存在或无歌曲的 album 返回 404', async () => {
    await withMockFetch(async (input) => {
        assert.equal(new URL(String(input)).pathname, '/eapi/album/v3/detail');
        return jsonUpstreamResponse({ code: 404 });
    }, async () => {
        const response = await requestWorker(
            'https://worker.example/?server=netease&type=album&id=3411281'
        );

        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: '网易云专辑不存在或为空' });
    });
});

test('网易云 album 拒绝上游返回的错配专辑', async () => {
    await withMockFetch(async (input) => {
        assert.equal(new URL(String(input)).pathname, '/eapi/album/v3/detail');
        return jsonUpstreamResponse({
            code: 200,
            album: { id: 9999999 },
            songs: [createRawSong(1)],
        });
    }, async () => {
        const response = await requestWorker(
            'https://worker.example/?server=netease&type=album&id=3411281'
        );

        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { error: '网易云专辑详情 ID 不匹配' });
    });
});
