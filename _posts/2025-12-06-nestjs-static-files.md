---
layout: post
title: NestJS에서 오디오·이미지 정적 파일 제공 — ServeStatic, 캐시 헤더, Range 요청
date: 2025-12-06
tags: [nestjs]
description: "@nestjs/serve-static의 옵션과 내부 동작, express.static의 캐시·조건부 요청 옵션, 오디오 탐색에 필요한 Range 요청과 206 응답, 해시 파일명 기반 캐시 무효화와 보안 설정을 정리한다."
---

말하기 훈련 앱은 문항마다 원어민 음성 파일과 그림 파일이 붙는다. 서비스 초기에는 이 파일들을 별도 스토리지 없이 API 서버가 직접 내려보내는 경우가 많다. NestJS에서는 `@nestjs/serve-static` 모듈 하나로 시작할 수 있지만, 기본값 그대로 두면 캐시가 전혀 되지 않거나, 반대로 파일을 교체해도 앱이 옛 파일을 계속 쓰는 문제가 생긴다. 오디오는 탐색(Seek)을 위해 Range 요청도 제대로 처리해야 한다.

## ServeStaticModule의 동작

NestJS 11 기준 `@nestjs/serve-static` 5.x를 쓴다. Express 어댑터에서는 내부적으로 Express의 `express.static`(serve-static 미들웨어, 그 아래 send 라이브러리)을 등록한다.

```typescript
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'media'),
      serveRoot: '/media',
      serveStaticOptions: {
        index: false,
        fallthrough: false,
        maxAge: '365d',
        immutable: true,
      },
    }),
  ],
})
export class AppModule {}
```

| 옵션 | 의미 |
|---|---|
| `rootPath` | 파일을 읽을 디렉터리. 기본값은 `client` |
| `serveRoot` | URL 접두사. `/media/a.mp3` → `rootPath/a.mp3` |
| `renderPath` | SPA용 `index.html`을 응답할 경로. Express 기본값은 모든 경로 |
| `exclude` | `renderPath` 처리에서 제외할 경로 목록(Fastify 미지원) |
| `useGlobalPrefix` | `setGlobalPrefix`로 지정한 접두사를 `serveRoot` 앞에 붙임 |
| `serveStaticOptions` | `express.static`에 그대로 전달되는 옵션 |

이 모듈은 원래 SPA 프론트엔드를 서빙하려고 만들어졌다. 그래서 정적 파일 미들웨어 외에 `serveRoot + renderPath`(기본 `{*any}`) 경로로 `rootPath/index.html`을 돌려주는 GET 핸들러도 함께 등록한다. 미디어 디렉터리에는 `index.html`이 없으므로 없는 파일을 요청하면 이 핸들러가 `index.html`을 찾다 실패해 404를 낸다. 반대로 미디어 디렉터리에 실수로 `index.html`이 들어가면 존재하지 않는 모든 경로에 그 파일이 200으로 응답되니 주의한다.

`exclude`는 이름과 달리 정적 파일 서빙에서 경로를 빼는 옵션이 아니라, SPA 폴백(`index.html` 응답)에서 API 경로를 빼는 옵션이다. `serveRoot`를 지정하지 않고 루트에 SPA를 올릴 때 `/api` 경로가 `index.html`에 가로채이지 않도록 쓴다. NestJS 11은 Express 5와 path-to-regexp 8을 쓰므로 와일드카드도 `'/api/{*path}'`처럼 이름 있는 형식으로 적는다.

## express.static의 캐시 관련 옵션

`serveStaticOptions`는 send 라이브러리 옵션으로 이어진다. Express 5(serve-static 2.x, send 1.x) 기준 기본값은 다음과 같다.

| 옵션 | 기본값 | 역할 |
|---|---|---|
| `maxAge` | `0` | `Cache-Control: public, max-age=N`. 밀리초 숫자 또는 `'1d'` 같은 문자열 |
| `immutable` | `false` | `Cache-Control`에 `immutable` 추가. `maxAge`와 함께 써야 의미가 있음 |
| `cacheControl` | `true` | `false`면 `Cache-Control`을 붙이지 않고 `maxAge`, `immutable`도 무시 |
| `etag` | `true` | 파일 크기·수정 시각 기반 `ETag` 생성 |
| `lastModified` | `true` | 파일 수정 시각으로 `Last-Modified` 설정 |
| `acceptRanges` | `true` | `Accept-Ranges: bytes`와 Range 요청 처리 |
| `dotfiles` | `'ignore'` | `.`으로 시작하는 경로는 없는 파일로 취급 |
| `index` | `'index.html'` | 디렉터리 요청 시 응답할 파일. 미디어에는 `false` |
| `fallthrough` | `true` | 파일이 없을 때 `next()`로 넘길지 여부 |
| `setHeaders` | 없음 | 파일별로 헤더를 추가하는 함수 `(res, path, stat)` |

기본값 `maxAge: 0`이면 `Cache-Control: public, max-age=0`이 붙는다. 클라이언트는 매번 서버에 재검증을 요청하고, 서버는 `If-None-Match`(ETag)나 `If-Modified-Since`(Last-Modified)를 보고 바뀌지 않았으면 본문 없이 304를 돌려준다. 전송량은 줄지만 왕복은 매번 생긴다.

## 캐시 무효화는 파일명으로

긴 `maxAge`를 주면 왕복이 사라진다. 대신 같은 URL의 파일을 교체해도 클라이언트는 만료 전까지 옛 파일을 쓴다. 이 둘을 동시에 얻는 방법은 **내용이 바뀌면 URL이 바뀌게** 하는 것이다.

```text
media/
  audio/apple.3f9a1c2b.mp3
  audio/banana.8d04e7aa.mp3
  images/apple.b71c0e45.webp
```

파일 내용의 해시를 파일명에 넣고, DB에는 이 경로를 저장한다. 문항의 음성을 다시 녹음하면 해시가 달라져 새 URL이 되고, 옛 URL은 그대로 남아도 아무도 참조하지 않는다. 이렇게 하면 URL 하나가 영원히 같은 내용을 가리키므로 `maxAge: '365d'`, `immutable: true`가 안전하다. `immutable`이 붙으면 이를 지원하는 클라이언트는 `max-age` 기간 동안 조건부 재검증조차 보내지 않는다.

```typescript
import { createHash } from 'node:crypto';

export function hashedName(original: string, buffer: Buffer): string {
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 8);
  const dot = original.lastIndexOf('.');
  return `${original.slice(0, dot)}.${hash}${original.slice(dot)}`;
}
```

해시를 쓸 수 없는 파일(외부 도구가 고정 이름으로 덮어쓰는 파일 등)은 다른 디렉터리로 분리하고 짧은 `maxAge`와 ETag 재검증에 맡긴다. 같은 디렉터리 안에서 정책을 나눠야 한다면 `setHeaders`에서 경로별로 `Cache-Control`을 직접 지정한다. send는 `Cache-Control`이 이미 설정되어 있으면 덮어쓰지 않는다.

## 오디오 탐색과 Range 요청

오디오 플레이어에서 재생 바를 중간으로 옮기면 클라이언트는 파일 전체를 다시 받지 않고 필요한 구간만 요청한다. 이것이 HTTP 범위 요청(Range Request)이다. RFC 9110 기준 흐름은 다음과 같다.

```http
GET /media/audio/apple.3f9a1c2b.mp3 HTTP/1.1
Range: bytes=65536-

HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 65536-482303/482304
Content-Length: 416768
Content-Type: audio/mpeg
```

| 상태 | 조건 |
|---|---|
| `206 Partial Content` | 범위가 유효함. `Content-Range`에 실제 바이트 구간과 전체 크기 |
| `416 Range Not Satisfiable` | 범위가 파일 크기를 벗어남. `Content-Range: bytes */전체크기` |
| `200 OK` | 서버가 Range를 무시하거나, `If-Range` 조건이 맞지 않아 전체를 보냄 |

RFC 9110에서 Range 지원은 서버의 선택 사항이라 서버가 Range를 무시하고 200으로 전체를 보내도 프로토콜 위반은 아니다. 하지만 플레이어 입장에서는 다르다. Apple의 Safari 웹 콘텐츠 가이드는 iOS용 미디어를 호스팅하는 HTTP 서버가 바이트 범위 요청을 지원해야 한다고 명시하며, 미디어 재생의 임의 접근에 이를 사용한다고 설명한다. Range를 지원하지 않는 서버에서는 탐색이 안 되거나 재생 자체가 실패할 수 있다.

send는 `acceptRanges`가 켜져 있으면(기본값) 이를 처리한다. 단일 범위는 206으로 응답하고, 범위를 벗어나면 416을, `If-Range`의 ETag·날짜가 현재 파일과 다르면 전체를 200으로 보낸다. 여러 범위를 한 번에 요청하면 send는 겹치는 범위를 합친 뒤에도 둘 이상이 남을 경우 `multipart/byteranges` 대신 전체 파일을 200으로 보낸다. 오디오 플레이어는 보통 단일 범위만 요청하므로 문제가 되지 않는다.

직접 컨트롤러에서 `res.sendFile()`이나 `StreamableFile`로 파일을 내려보내는 경우는 구분해야 한다. `res.sendFile()`은 send를 쓰므로 Range가 처리되지만, `StreamableFile`에 스트림을 넘기면 Range 헤더를 해석하지 않고 항상 전체를 보낸다. 권한 확인이 필요한 오디오를 직접 스트리밍해야 한다면 Range 파싱을 구현하거나 `res.sendFile()`을 쓴다.

```bash
curl -s -o /dev/null -D - -H 'Range: bytes=0-99' http://localhost:3000/media/audio/apple.3f9a1c2b.mp3
```

이 요청에 `206`과 `Content-Range: bytes 0-99/...`가 돌아오면 정상이다. 리버스 프록시나 CDN을 앞에 두었다면 그 경로에서도 같은 결과가 나오는지 확인한다. 중간 장비가 Range 헤더를 제거하면 서버 설정이 맞아도 탐색이 깨진다.

## 보안

**경로 탐색(Path Traversal)**: `/media/../.env` 같은 요청은 send가 막는다. send는 `root` 기준으로 경로를 정규화하고, 상위 디렉터리로 벗어나는 `..` 세그먼트가 있으면 403으로 거부한다. 직접 `fs.createReadStream(join(dir, req.params.name))` 같은 코드를 쓰면 이 보호가 사라지므로, 파일 제공은 send 기반 API에 맡긴다.

**업로드 디렉터리를 그대로 서빙하지 않는다**: 사용자가 올린 파일을 정적 디렉터리에 바로 저장하면, `.html`이나 `.svg` 파일이 우리 도메인에서 열리면서 스크립트가 실행될 수 있다(저장형 XSS). 업로드는 허용 확장자(`mp3`, `m4a`, `webp`, `png` 등)만 받고, 저장 파일명은 서버가 생성하며, 운영자가 검수한 콘텐츠 디렉터리와 분리한다.

**Content-Type과 nosniff**: send는 파일 확장자로 `Content-Type`을 정하고, 알 수 없는 확장자는 `application/octet-stream`으로 보낸다. 브라우저가 내용을 보고 타입을 추측(MIME Sniffing)하지 않도록 `X-Content-Type-Options: nosniff`를 붙인다.

```typescript
serveStaticOptions: {
  index: false,
  fallthrough: false,
  dotfiles: 'deny',
  maxAge: '365d',
  immutable: true,
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
},
```

**인증과 정적 파일**: `ServeStaticModule`은 Nest 라우터 바깥의 Express 미들웨어로 등록되므로 전역 가드(`APP_GUARD`)가 적용되지 않는다. 누구나 URL만 알면 받을 수 있다는 뜻이다. 유료 콘텐츠처럼 접근 제어가 필요한 파일은 정적 서빙 대상에서 빼고, 서명된 URL이나 권한을 확인하는 컨트롤러로 제공한다.

## 언제 오브젝트 스토리지로 옮기나

API 서버가 파일을 직접 서빙하면 배포 이미지나 볼륨에 미디어가 묶이고, 서버를 여러 대로 늘릴 때 파일 동기화가 필요하며, 대용량 전송이 API 처리 능력을 잡아먹는다. 콘텐츠가 운영 중 자주 추가되거나 트래픽이 커지면 S3 같은 오브젝트 스토리지와 CDN으로 옮긴다. 업로드 흐름은 [S3 Presigned URL과 멀티파트 업로드](/2024/05/07/s3-presigned-multipart-upload/)에서 다뤘다.

| 기준 | ServeStaticModule | 오브젝트 스토리지 + CDN |
|---|---|---|
| 구성 | 모듈 하나 | 버킷, CDN, 업로드 경로 |
| 파일 배포 | 이미지·볼륨에 포함 | 서버와 독립 |
| 수평 확장 | 파일 동기화 필요 | 문제없음 |
| 전송 부하 | API 서버가 부담 | CDN이 부담 |
| Range·캐시 | send 옵션으로 설정 | 스토리지·CDN이 기본 지원 |
| 접근 제어 | 가드 미적용, 별도 구현 | 서명된 URL |
| 적합한 단계 | 초기, 소량의 고정 콘텐츠 | 콘텐츠 증가, 트래픽 증가 |

## 정리

1. `ServeStaticModule`은 `express.static`을 등록하고 SPA용 `index.html` 폴백도 함께 건다. 미디어 디렉터리에는 `index: false`를 주고 `index.html`을 두지 않는다.
2. `exclude`는 SPA 폴백에서 API 경로를 빼는 옵션이며, Express 5에서는 `{*path}` 형식 와일드카드를 쓴다.
3. 기본값 `maxAge: 0`은 매번 재검증한다. 파일명에 내용 해시를 넣고 `maxAge: '365d'`, `immutable: true`로 캐시한다.
4. 오디오 탐색에는 Range 요청과 206 응답이 필요하다. send는 기본으로 지원하지만 `StreamableFile` 직접 스트리밍은 지원하지 않는다.
5. 경로 탐색은 send가 막는다. 업로드 디렉터리를 그대로 서빙하지 말고, `nosniff`를 붙인다.
6. 정적 파일에는 전역 가드가 적용되지 않는다. 접근 제어가 필요하거나 규모가 커지면 오브젝트 스토리지와 CDN으로 옮긴다.
