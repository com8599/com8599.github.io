---
layout: post
title: SSR 페이지의 SEO — 메타 태그와 Open Graph
date: 2024-11-05
tags: [react]
description: 검색엔진과 링크 미리보기 크롤러가 HTML을 읽는 방식에 맞춰 title, description, canonical, robots, Open Graph, JSON-LD를 서버에서 라우트별로 만드는 방법.
---

서버 사이드 렌더링을 하면 본문은 HTML로 나가지만, 그것만으로 검색 결과와 메신저 미리보기가 원하는 대로 나오지는 않는다. 검색엔진은 `<title>`, 메타 설명, 정규 URL(canonical), robots 지시를 보고, 메신저와 SNS는 Open Graph 태그를 본다. 이 값들은 모두 `<head>`에 있어야 하고, 페이지마다 달라야 한다. 이 글은 각 태그가 어떤 의미를 가지는지와, 서버에서 라우트별로 `<head>`를 만드는 방법을 정리한다.

## Googlebot은 JavaScript를 어떻게 처리하는가

Google 검색 센터의 JavaScript SEO 기본 문서는 처리 과정을 크롤링(crawling), 렌더링(rendering), 색인(indexing) 세 단계로 설명한다.

1. 크롤러가 URL을 가져와 HTML 응답에서 링크를 찾는다.
2. HTTP 상태가 `200`인 페이지는 렌더링 대기열에 들어간다. 렌더링은 나중에 별도로 실행되며, 상시 최신 버전(evergreen)의 Chromium이 JavaScript를 실행한다.
3. 렌더링된 HTML로 색인한다.

즉 Google은 JavaScript를 실행하지만 그 시점은 크롤링과 분리되어 있다. 같은 문서는 서버 사이드 렌더링이나 사전 렌더링이 사용자와 크롤러 모두에게 사이트를 빠르게 하고, 모든 봇이 JavaScript를 실행하지는 않으므로 여전히 좋은 선택이라고 말한다. JavaScript로 다룰 때 주의할 점도 명시한다.

| 항목 | Google 문서의 지침 |
|---|---|
| `<title>`, 메타 설명 | JavaScript로 설정하거나 바꿀 수 있다 |
| canonical | HTML에 두는 것이 좋고, JavaScript로 다른 URL로 바꾸면 안 된다 |
| `noindex` | 처음 HTML에 `noindex`가 있으면 렌더링과 JS 실행을 건너뛸 수 있다. JS로 제거하는 방식은 동작하지 않을 수 있다 |
| 라우팅 | 프래그먼트(`#/path`) 대신 History API와 실제 `<a href>` 링크를 쓴다 |
| 없는 페이지 | 404 상태를 주기 어려운 SPA는 서버의 404 URL로 리디렉션하거나 `noindex`를 넣어 소프트 404를 피한다 |

SSR에서는 이 항목들을 처음 HTML에 정확히 넣을 수 있으므로, 렌더링 단계에 기대지 않아도 된다. 특히 없는 상품 페이지에 실제 `404` 상태 코드를 돌려줄 수 있다는 점이 크다.

## 링크 미리보기 크롤러는 서버 HTML만 본다

메신저나 SNS에 링크를 붙이면 해당 서비스의 크롤러가 URL을 가져와 Open Graph 태그로 미리보기 카드를 만든다. Facebook 크롤러 문서는 Open Graph 속성이 응답의 첫 1MB 안에 있어야 하고, 몇 초 안에 가져올 수 있어야 한다고 안내한다. JavaScript 실행 여부는 문서에 명시되어 있지 않지만, 미리보기 크롤러는 일반적으로 응답 HTML만 읽는다고 보고 설계하는 것이 안전하다. CSR 페이지에서 JS로 메타 태그를 넣으면 검색엔진에는 반영될 수 있어도 미리보기에는 나오지 않는 이유다.

이 점은 스트리밍 SSR과도 연결된다. `<head>`는 셸에 들어가므로 Suspense 경계 안의 느린 데이터와 상관없이 첫 바이트에 가깝게 나간다. 메타 태그에 필요한 데이터(상품명, 대표 이미지)는 셸을 렌더링하기 전에 조회해 두어야 한다.

## 검색엔진용 기본 태그

```html
<head>
  <title>원목 책상 120 - 가구샵</title>
  <meta name="description" content="120cm 원목 책상. 원목 상판, 높이 조절 가능, 무료 배송." />
  <link rel="canonical" href="https://shop.example.com/products/desk-120" />
  <meta name="robots" content="max-image-preview:large" />
</head>
```

- **`<title>`**: Google은 검색 결과의 제목 링크(title link)를 만들 때 `<title>`을 비롯해 페이지의 주요 제목, `<h1>`, `og:title` 등을 함께 참고한다. 모든 페이지에 제목을 두고, "홈"처럼 모호하거나 모든 페이지에 같은 상용구를 반복하지 말라고 권한다. 사이트 이름은 구분자와 함께 앞이나 뒤에 붙인다. 길이 제한은 없지만 결과 화면에서 잘릴 수 있다.
- **메타 설명**: Google은 페이지 본문보다 정확한 설명이라고 판단할 때 **가끔** 메타 설명을 스니펫으로 쓴다. 길이 제한은 없고, 모든 페이지에 같은 설명을 쓰는 것은 도움이 되지 않는다.
- **canonical**: 같은 내용이 여러 URL(정렬 파라미터, 추적 파라미터)로 접근될 때 대표 URL을 알린다. `<head>` 안에 있어야 인정되고, 절대 URL을 쓰는 것이 좋다. 지시가 아니라 강한 신호(signal)이며, 사이트맵 등 다른 방법과 서로 다른 URL을 가리키지 않게 한다.
- **robots**: 기본값은 색인과 링크 추적을 모두 허용하는 `all`이다. `noindex`, `nofollow`, `max-snippet`, `max-image-preview` 같은 규칙을 쓴다. robots.txt로 크롤링을 막으면 페이지의 `noindex`도 읽을 수 없으므로, 검색 결과에서 빼려면 크롤링은 허용하고 `noindex`를 준다. HTML이 아닌 응답에는 `X-Robots-Tag` HTTP 헤더를 쓴다.

## Open Graph

Open Graph 프로토콜(ogp.me)은 모든 페이지에 필요한 속성으로 네 가지를 정의한다.

| 속성 | 의미 |
|---|---|
| `og:title` | 그래프 안에서 보일 객체의 제목 |
| `og:type` | 객체 유형(`website`, `article` 등) |
| `og:image` | 객체를 대표하는 이미지 URL |
| `og:url` | 객체의 영구 ID로 쓰일 정규 URL |

선택 속성으로 `og:description`(한두 문장 설명), `og:site_name`, `og:locale`(`language_TERRITORY` 형식, 기본값 `en_US`)이 있고, 이미지에는 `og:image:width`, `og:image:height`, `og:image:type`, `og:image:alt` 같은 구조화 속성을 붙일 수 있다. 크기를 함께 주면 크롤러가 이미지를 내려받기 전에 레이아웃을 정할 수 있다. `og:url`은 canonical과 같은 값을 쓴다.

```html
<meta property="og:type" content="website" />
<meta property="og:title" content="원목 책상 120" />
<meta property="og:description" content="120cm 원목 책상. 높이 조절 가능." />
<meta property="og:url" content="https://shop.example.com/products/desk-120" />
<meta property="og:image" content="https://cdn.example.com/og/desk-120.jpg" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="밝은 원목 상판의 책상" />
<meta property="og:locale" content="ko_KR" />
```

### X(Twitter) 카드

X는 `twitter:` 접두사의 메타 태그로 카드 종류를 정한다. 작은 썸네일의 `summary`와 큰 이미지의 `summary_large_image`가 대표적이다. X의 카드 마크업 문서는 `twitter:title`, `twitter:description`, `twitter:image`가 없으면 대응하는 Open Graph 값을 쓴다고 설명하지만, `twitter:card`에는 대응하는 Open Graph 속성이 없으므로 직접 넣는다.

```html
<meta name="twitter:card" content="summary_large_image" />
```

## 라우트별 head를 서버에서 만들기

라이브러리 없이도 라우트마다 메타 정보를 객체로 만들고, 그 객체를 `<head>` 요소로 바꾸는 함수를 두면 충분하다. 데이터는 라우트 핸들러에서 렌더링 전에 조회하므로 스트리밍 셸에 그대로 들어간다.

```tsx
// src/client/seo.tsx
export type Seo = {
  title: string;
  description: string;
  path: string;
  image?: string;
  noindex?: boolean;
  jsonLd?: object;
};

const ORIGIN = 'https://shop.example.com';
const SITE = '가구샵';

export function Head({ seo }: { seo: Seo }) {
  const url = ORIGIN + seo.path;
  const image = seo.image ?? `${ORIGIN}/og/default.jpg`;
  const jsonLd = seo.jsonLd ? { __html: serializeJson(seo.jsonLd) } : undefined;

  return (
    <>
      <title>{`${seo.title} - ${SITE}`}</title>
      <meta name="description" content={seo.description} />
      <link rel="canonical" href={url} />
      {seo.noindex && <meta name="robots" content="noindex" />}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE} />
      <meta property="og:title" content={seo.title} />
      <meta property="og:description" content={seo.description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={image} />
      <meta name="twitter:card" content="summary_large_image" />
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd} />}
    </>
  );
}

function serializeJson(value: object): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
```

라우트 쪽에서는 데이터에서 `Seo` 객체를 만든다. 없는 상품이면 상태 코드 404와 함께 `noindex`를 준다.

```typescript
// src/ssr/seo-for-product.ts
import type { Seo } from '../client/seo';
import type { Product } from '../product/product.entity';

export function seoForProduct(id: string, product: Product | null): Seo {
  if (!product) {
    return { title: '상품을 찾을 수 없습니다', description: '', path: `/products/${id}`, noindex: true };
  }
  return {
    title: product.name,
    description: product.summary.slice(0, 120),
    path: `/products/${product.slug}`,
    image: product.ogImageUrl,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.name,
      image: [product.imageUrl],
      description: product.summary,
    },
  };
}
```

`path`에 요청 URL 대신 데이터의 `slug`를 쓰는 이유는 canonical이 쿼리 문자열이나 대소문자 차이에 따라 흔들리지 않게 하기 위해서다. 메타 설명을 잘라 쓰는 길이는 정해진 규칙이 아니라 결과 화면에서 잘리지 않을 정도로 정한 값이다.

## 구조화 데이터(JSON-LD)

구조화 데이터는 페이지가 무엇인지(상품, 기사, 이벤트)를 schema.org 어휘로 기계가 읽을 수 있게 표시한다. Google은 JSON-LD, Microdata, RDFa를 모두 지원하고 유효하다면 셋 다 동등하게 처리하지만, 구현과 유지보수가 쉬운 JSON-LD를 권장한다. 본문 마크업과 섞이지 않고 `<script type="application/ld+json">` 하나로 끝나기 때문이다. JavaScript로 동적으로 넣어도 읽을 수 있지만, SSR이라면 처음 HTML에 넣는 편이 단순하다.

구조화 데이터는 리치 결과(rich result)의 자격 조건일 뿐 표시를 보장하지는 않는다. 유형별 필수·권장 속성을 Google 문서에서 확인하고, 리치 결과 테스트(Rich Results Test)로 검증한다. 스크립트 안에 들어가므로 앞 글의 초기 데이터와 마찬가지로 `<`를 이스케이프해야 한다.

## 태그별 비교

| 태그 | 읽는 주체 | 없을 때 | 주의 |
|---|---|---|---|
| `<title>` | 검색엔진, 브라우저 탭 | 페이지 내용에서 제목을 추정 | 페이지마다 다르게, 사이트 이름은 구분자로 |
| `meta description` | 검색엔진 | 본문에서 스니펫 생성 | 가끔만 사용됨, 중복 금지 |
| `link rel=canonical` | 검색엔진 | Google이 대표 URL을 스스로 선택 | `<head>` 안, 절대 URL, JS로 변경 금지 |
| `meta robots` | 검색엔진 | `all`(색인·추적 허용) | robots.txt 차단 시 읽히지 않음 |
| `og:*` | 메신저, SNS 미리보기 | 서비스마다 다르게 처리(미리보기 누락 등) | 처음 HTML에 있어야 함 |
| `twitter:card` | X | 카드 종류가 지정되지 않음 | Open Graph 대체값 없음, 직접 지정 |
| JSON-LD | 검색엔진 | 리치 결과 자격 없음 | 표시는 보장되지 않음 |

## 정리

1. Google은 JavaScript를 실행하지만 렌더링은 크롤링과 분리된 나중 단계이고, 모든 봇이 JS를 실행하지는 않는다.
2. 링크 미리보기 크롤러는 응답 HTML의 Open Graph를 읽으므로 `<head>`는 서버에서 만들어야 한다.
3. `<title>`과 메타 설명은 페이지마다 다르게, canonical은 `<head>` 안 절대 URL로, `noindex`는 처음 HTML에 넣는다.
4. Open Graph 필수 속성은 `og:title`, `og:type`, `og:image`, `og:url` 네 가지이고 `og:url`은 canonical과 맞춘다.
5. 라우트별 메타 정보를 객체로 만들고 하나의 head 함수로 렌더링하면 라이브러리 없이도 일관성을 유지할 수 있다.
6. 구조화 데이터는 JSON-LD로 넣고, 스크립트 안의 `<`는 이스케이프한다.
