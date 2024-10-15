---
layout: post
title: 서버 사이드 렌더링(SSR)과 하이드레이션(Hydration) — NestJS + React
date: 2024-10-15
tags: [nestjs, react]
description: CSR·SSR·SSG의 차이와 React 18 스트리밍 렌더링, 하이드레이션 불일치의 원인과 해결, NestJS에서 HTML을 스트리밍하는 구성을 정리한다.
---

React 애플리케이션을 브라우저에서만 렌더링하면 서버가 보내는 HTML은 빈 `<div id="root">`와 스크립트 태그뿐이다. 사용자는 번들을 내려받고 실행하고 데이터를 다시 요청한 뒤에야 첫 화면을 본다. 서버 사이드 렌더링(Server-Side Rendering, SSR)은 같은 컴포넌트를 서버에서 먼저 HTML로 만들어 보내고, 브라우저에서는 그 HTML에 이벤트 핸들러를 붙여 다시 상호작용 가능하게 만드는 방식이다. 이 "붙이는" 단계를 하이드레이션(Hydration)이라고 한다. 검색엔진과 링크 미리보기에 완성된 HTML을 줄 수 있다는 점도 동기지만, 그 내용은 다음 글에서 따로 다룬다.

## CSR, SSR, SSG

| 방식 | HTML이 만들어지는 시점 | 첫 화면 | 서버 부하 | 적합한 화면 |
|---|---|---|---|---|
| CSR(Client-Side Rendering) | 브라우저에서 JS 실행 후 | 번들 로드·실행·데이터 요청 후 | 정적 파일 제공뿐 | 로그인 뒤의 대시보드, 관리 화면 |
| SSR | 요청마다 서버에서 | 서버 응답 직후(상호작용은 하이드레이션 후) | 요청마다 렌더링 | 요청별로 내용이 다른 공개 페이지 |
| SSG(Static Site Generation) | 빌드 시점에 한 번 | 정적 파일 응답 직후 | 거의 없음 | 내용이 자주 바뀌지 않는 문서, 랜딩 |

SSR이 첫 화면을 빨리 보여 준다고 해서 바로 클릭할 수 있는 것은 아니다. HTML이 보이는 시점과 하이드레이션이 끝나 상호작용이 가능한 시점 사이에는 여전히 번들 로드와 실행이 있다. SSR은 "보이는 시점"을 앞당기는 기술이고, 번들 크기를 줄이는 일은 별개로 남는다.

## renderToString과 renderToPipeableStream

React 18의 서버 API는 `react-dom/server`에 있다.

- `renderToString(element)`: 트리를 문자열로 즉시 반환한다. 스트리밍을 지원하지 않고 데이터를 기다리지도 않는다. 컴포넌트가 일시 중단(suspend)되면 가장 가까운 `<Suspense>`의 `fallback`을 HTML로 내보내고, 실제 내용은 클라이언트 코드가 로드된 뒤에야 나타난다.
- `renderToPipeableStream(element, options)`: Node.js 스트림으로 HTML을 쓴다. `<Suspense>` 경계 밖의 셸(shell)을 먼저 보내고, 경계 안의 내용이 준비되면 같은 응답 안에 HTML과 교체용 인라인 스크립트를 이어서 보낸다. Web Streams 환경(Deno, 엣지 런타임)에는 `renderToReadableStream`이 대응한다.

`renderToPipeableStream`은 `{ pipe, abort }`를 반환하고, 주요 옵션은 다음과 같다.

| 옵션 | 시점·역할 |
|---|---|
| `bootstrapScripts` / `bootstrapModules` | 하이드레이션을 시작할 스크립트 URL. 후자는 `<script type="module">`로 출력 |
| `onShellReady` | 셸 렌더링 완료. 상태 코드를 정하고 `pipe(res)`로 스트리밍 시작 |
| `onShellError` | 셸 렌더링 실패. 아직 아무 바이트도 보내지 않았으므로 대체 HTML을 보낼 수 있음 |
| `onAllReady` | Suspense 내용까지 모두 완료. 크롤러 응답이나 정적 생성에 사용 |
| `onError` | 복구 가능 여부와 관계없이 서버 오류마다 호출 |

스트리밍이 시작되면 상태 코드를 바꿀 수 없다. 그래서 상태 코드는 `onShellReady`에서 정하고, 셸 밖(Suspense 안)의 오류는 `onError`에서 플래그로 기록해 둔다. 셸에서 실패한 경우만 500을 확실히 돌려줄 수 있으므로, 오류 여부가 상태 코드에 반드시 반영되어야 하는 내용은 셸에 둔다. `abort()`를 호출하면 남은 경계는 fallback HTML로 마무리되고 나머지는 클라이언트에서 렌더링된다. 느린 데이터 때문에 응답이 무한정 열려 있지 않도록 타임아웃과 함께 쓴다.

## hydrateRoot와 하이드레이션 불일치

클라이언트에서는 `createRoot` 대신 `hydrateRoot(domNode, reactNode, options)`를 쓴다. React는 서버 HTML을 새로 그리지 않고, 같은 트리를 렌더링하면서 기존 DOM 노드를 재사용하고 이벤트 핸들러를 연결한다. 이 과정은 **클라이언트의 첫 렌더링 결과가 서버 HTML과 같다**는 전제 위에 있다.

공식 문서는 불일치를 버그로 다루라고 한다. React가 일부 불일치에서 복구하더라도 최선의 경우 느려지고, 최악의 경우 이벤트 핸들러가 엉뚱한 요소에 붙는다. 복구된 오류는 `onRecoverableError` 옵션으로 받아 로깅할 수 있다.

| 원인 | 예 | 해결 |
|---|---|---|
| 시간 | `new Date().toLocaleTimeString()`을 렌더링 | 서버에서 정한 기준 시각을 데이터로 넘기거나, 클라이언트 전용 값은 Effect 이후에 표시 |
| 브라우저 전용 API | `typeof window !== 'undefined'` 분기, `window.matchMedia` | 첫 렌더링은 서버와 같게 두고 `useEffect`에서 갱신 |
| 난수·ID | `Math.random()`으로 만든 `id` | `useId` 사용(서버와 클라이언트에서 같은 값) |
| 로캘·시간대 | `toLocaleString()`이 서버 OS 로캘·시간대를 따름 | `Intl.DateTimeFormat`에 로캘과 `timeZone`을 명시 |
| 데이터 차이 | 서버와 클라이언트가 데이터를 따로 조회 | 서버가 쓴 데이터를 직렬화해 그대로 재사용 |
| 마크업 | 루트 노드 안쪽의 여분 공백·줄바꿈 | 템플릿에서 루트 내부를 비움 |

의도적으로 클라이언트에서만 다른 내용을 보여 줘야 할 때는 두 번 렌더링(two-pass rendering)을 쓴다. 첫 렌더링은 서버와 같은 결과를 내고, Effect에서 상태를 바꿔 한 번 더 렌더링한다. 하이드레이션 직후 렌더링이 한 번 더 일어나므로 남용하면 느려진다.

```tsx
import { useEffect, useState } from 'react';

export function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState(iso.slice(0, 10));

  useEffect(() => {
    setText(new Date(iso).toLocaleString());
  }, [iso]);

  return <time dateTime={iso}>{text}</time>;
}
```

`suppressHydrationWarning`은 타임스탬프처럼 한 요소의 속성이나 텍스트가 어쩔 수 없이 다를 때 경고를 끄는 탈출구다. **한 단계 깊이에만** 적용되고, React는 불일치한 텍스트를 클라이언트 값으로 고쳐 주지 않는다. 상위 요소에 붙여 하위 트리 전체의 불일치를 덮는 용도로는 쓸 수 없다.

## 초기 데이터 전달과 XSS 방어

서버가 조회한 데이터를 클라이언트가 다시 요청하면 응답이 늦어질 뿐 아니라, 두 응답 사이에 데이터가 바뀌어 불일치가 생긴다. 서버 데이터를 HTML 안에 직렬화해 넣고 클라이언트가 그대로 읽는다.

이때 `JSON.stringify` 결과를 `<script>` 안에 그대로 넣으면 위험하다. HTML 파서는 스크립트 내용 안에서 `</script`를 만나면 JSON 문자열 안이든 아니든 요소를 닫는다. 사용자가 입력한 상품명에 `</script><script>...`가 들어 있으면 그대로 실행된다. HTML 명세도 스크립트 안의 `<!--`, `<script`, `</script`를 이스케이프하라고 권한다. JSON에서 `<`는 문자열 안에만 나올 수 있으므로 `<`로 바꾸면 의미는 같고 파서는 태그로 보지 않는다.

```typescript
// src/ssr/serialize.ts
export function serializeState(state: unknown): string {
  return JSON.stringify(state)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
```

`type="application/json"`인 스크립트에 넣고 `JSON.parse`로 읽으면 실행 가능한 코드가 아니라 데이터로만 다룰 수 있다.

```tsx
// src/client/Html.tsx
import type { ReactNode } from 'react';
import { serializeState } from '../ssr/serialize';

export type SsrState = { url: string; product: { id: string; name: string } | null };

export function Html(props: { state: SsrState; css: string[]; children: ReactNode }) {
  const stateHtml = { __html: serializeState(props.state) };
  return (
    <html lang="ko">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {props.css.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
      </head>
      <body>
        <div id="app">{props.children}</div>
        <script
          id="__SSR_STATE__"
          type="application/json"
          dangerouslySetInnerHTML={stateHtml}
        />
      </body>
    </html>
  );
}
```

## NestJS 컨트롤러에서 스트리밍

NestJS의 기본 HTTP 플랫폼은 Express다. 스트림을 직접 응답에 연결해야 하므로 `@Res()`로 Express 응답 객체를 주입한다. 이 방식에서는 응답을 보내는 책임이 핸들러에 있고, 인터셉터나 `@HttpCode()`, `@Header()` 같은 표준 응답 처리 기능은 해당 라우트에서 동작하지 않는다. 서버 코드에서 JSX를 쓰려면 `tsconfig.json`에 `"jsx": "react-jsx"`를 설정한다.

```tsx
// src/ssr/ssr.controller.tsx
import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { renderToPipeableStream } from 'react-dom/server';
import { App } from '../client/App';
import { Html } from '../client/Html';
import { AssetManifest } from './asset-manifest';
import { ProductService } from '../product/product.service';

@Controller()
export class SsrController {
  constructor(
    private readonly products: ProductService,
    private readonly assets: AssetManifest,
  ) {}

  @Get('products/:id')
  async product(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const product = await this.products.findById(id);
    const state = { url: req.originalUrl, product };
    let didError = false;

    const { pipe, abort } = renderToPipeableStream(
      <Html state={state} css={this.assets.css}>
        <App state={state} />
      </Html>,
      {
        bootstrapModules: [this.assets.entry],
        onShellReady() {
          res.statusCode = didError ? 500 : product ? 200 : 404;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          pipe(res);
        },
        onShellError() {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send('<!doctype html><h1>일시적인 오류입니다.</h1>');
        },
        onError(error) {
          didError = true;
          console.error(error);
        },
      },
    );

    setTimeout(abort, 10_000);
  }
}
```

클라이언트 진입점은 같은 `Html`과 `App`을 같은 데이터로 렌더링한다. 서버가 문서 전체(`<html>`)를 렌더링했으므로 `document`에 하이드레이션한다.

```tsx
// src/client/entry-client.tsx
import { hydrateRoot } from 'react-dom/client';
import { App } from './App';
import { Html, type SsrState } from './Html';

const el = document.getElementById('__SSR_STATE__');
const state = JSON.parse(el?.textContent ?? '{}') as SsrState;
const css = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
  .map((link) => link.getAttribute('href') ?? '');

hydrateRoot(
  document,
  <Html state={state} css={css}>
    <App state={state} />
  </Html>,
  { onRecoverableError: (error) => console.warn('hydration recovered', error) },
);
```

## 클라이언트 번들: Vite 매니페스트

클라이언트 번들은 Vite나 webpack으로 따로 빌드하고, 서버는 결과 파일 이름만 알면 된다. 해시가 붙은 파일 이름은 빌드마다 바뀌므로 Vite의 `build.manifest`를 켜서 진입점과 CSS 경로를 읽는다. Vite 5는 매니페스트를 `outDir/.vite/manifest.json`에 쓴다.

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    manifest: true,
    rollupOptions: { input: 'src/client/entry-client.tsx' },
  },
});
```

```typescript
// src/ssr/asset-manifest.ts
import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Chunk = { file: string; css?: string[]; isEntry?: boolean };

@Injectable()
export class AssetManifest {
  readonly entry: string;
  readonly css: string[];

  constructor() {
    const path = join(process.cwd(), 'dist/client/.vite/manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, Chunk>;
    const chunk = manifest['src/client/entry-client.tsx'];
    this.entry = '/' + chunk.file;
    this.css = (chunk.css ?? []).map((file) => '/' + file);
  }
}
```

정적 파일은 `NestFactory.create<NestExpressApplication>(AppModule)`로 만든 앱에서 `app.useStaticAssets(join(process.cwd(), 'dist/client'), { index: false })`로 제공한다. Vite 개발 서버를 미들웨어 모드로 붙이는 구성도 가능하지만, Vite 문서가 밝히듯 SSR API는 라이브러리·프레임워크 작성자를 위한 저수준 API다. 개발 중에는 클라이언트를 CSR로 띄우고 SSR은 빌드 결과로 확인하는 편이 단순하다.

## 정리

1. SSR은 첫 화면이 보이는 시점을 앞당기고, 하이드레이션이 끝나야 상호작용이 가능하다. 요청마다 내용이 다르지 않다면 SSG가 더 싸다.
2. React 18에서는 `renderToString` 대신 `renderToPipeableStream`을 쓴다. 상태 코드는 `onShellReady`에서 정하고, `abort()`로 응답 시간을 제한한다.
3. `hydrateRoot`는 첫 클라이언트 렌더링이 서버 HTML과 같다고 가정한다. 시간, `window`, 난수, 로캘 차이가 대표 원인이며 불일치는 버그로 다룬다.
4. 클라이언트 전용 값은 `useEffect` 이후에 표시하고, `suppressHydrationWarning`은 한 요소의 불가피한 차이에만 쓴다.
5. 초기 데이터는 직렬화해 넘기되 `<`, `>`, `&`를 유니코드 이스케이프해 `</script>` 주입을 막는다.
6. NestJS에서는 `@Res()`로 Express 응답에 직접 스트리밍하고, 해시가 붙은 번들 경로는 Vite 매니페스트에서 읽는다.
