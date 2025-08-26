---
layout: post
title: 서비스를 합치는 동안 클라이언트 지키기 — 게이트웨이 라우팅과 스트랭글러 피그(Strangler Fig) 패턴
date: 2025-08-26
tags: [nestjs]
description: 백엔드 서비스를 옮기거나 합치는 동안 공개 API 경로를 그대로 유지하는 방법을 게이트웨이 라우팅, 섀도 트래픽 비교, 점진적 전환, 폐기 헤더(Deprecation, Sunset), 롤백 순서로 정리한다.
---

[너무 잘게 쪼갠 마이크로서비스 합치기](/2025/07/08/merging-microservices/)에서 서비스 경계를 다시 긋고 모듈러 모놀리스로 합치는 단계를 다뤘다. 서버 쪽 작업이 아무리 잘 돼도, 그 과정에서 앱이나 외부 파트너가 부르는 주소와 응답이 바뀌면 전환은 클라이언트 배포 일정에 묶인다. 모바일 앱은 구버전이 오래 남기 때문에 더 그렇다.

이 글은 백엔드를 옮기는 동안 클라이언트가 아무것도 바꾸지 않아도 되게 만드는 방법, 즉 게이트웨이에서 경로 단위로 트래픽을 옮기는 스트랭글러 피그(Strangler Fig) 방식을 정리한다.

## 스트랭글러 피그와 게이트웨이

Martin Fowler는 2001년 호주 퀸즐랜드의 열대우림에서 본 교살무화과(Strangler Fig)에 빗대어 이 방식을 설명한다. 무화과 덩굴은 숙주 나무를 감싸며 자라다가 결국 숙주를 대신한다. 소프트웨어에서는 기존 시스템을 한 번에 바꾸지 않고, 새 기능을 기존 코드와 분리해 옆에 만들면서 동작을 조금씩 옮긴다. Fowler는 이를 위해 기존 시스템에서 부분을 독립적으로 교체할 수 있는 이음매(Seam)를 찾고, 두 시스템이 공존하도록 하는 **과도기 아키텍처(Transitional Architecture)** 를 만들라고 한다. 이 코드는 전환이 끝나면 지운다.

HTTP API에서 가장 쓰기 좋은 이음매는 게이트웨이다. Azure Architecture Center의 게이트웨이 라우팅(Gateway Routing) 패턴은 서비스 앞에 게이트웨이를 두고 7계층 라우팅으로 요청을 알맞은 서비스로 보내는 구성을 설명하며, 서비스를 합치거나 나누거나 교체해도 클라이언트는 게이트웨이만 부르고 **라우팅만 바뀐다**는 점을 장점으로 든다. 같은 문서는 게이트웨이가 단일 장애 지점과 병목이 될 수 있으므로 가용성과 확장성을 함께 설계하라고 경고한다.

| 전환 방식 | 클라이언트 영향 | 되돌리기 | 위험 |
|---|---|---|---|
| 빅뱅 교체 | 주소·응답이 바뀌면 동시 배포 필요 | 전체 롤백 | 한 번에 모든 차이가 드러남 |
| 클라이언트가 새 주소를 직접 호출 | 앱 업데이트 필요, 구버전 앱은 계속 옛 주소 | 앱 재배포 | 구버전 앱 때문에 옛 서비스를 못 내림 |
| DNS 전환 | 없음 | DNS TTL만큼 지연 | 경로 단위로 나눌 수 없음 |
| 게이트웨이 경로 라우팅 | 없음 | 설정 변경 | 게이트웨이 자체의 가용성 |

## 공개 경로를 계약으로 고정한다

전환의 전제는 **공개 경로와 응답 형식이 백엔드 구조와 무관하게 고정**되어 있는 것이다. `/api/v1/orders`가 주문 서비스에 있든, 합친 서비스의 주문 모듈에 있든 클라이언트는 같은 경로, 같은 응답을 받아야 한다.

이를 위해 경로를 서비스 이름이 아니라 리소스 이름으로 짓는다. `/order-service/orders`처럼 서비스 이름이 경로에 들어가 있다면, 게이트웨이에서 리소스 중심 경로를 새로 열고 옛 경로는 같은 대상으로 보내면서 폐기 절차(뒤에서 설명)를 밟는다.

## 라우팅 테이블: nginx

경로 접두사별로 대상을 정한 표가 곧 전환 진행 상황이다.

```nginx
upstream legacy_orders    { server orders-svc:3000; }
upstream legacy_inventory { server inventory-svc:3000; }
upstream legacy_payments  { server payments-svc:3000; }
upstream commerce         { server commerce:3000; }   # 합친 서비스

# 사용자 ID 기준으로 10%만 새 서비스로
split_clients "${http_x_user_id}" $orders_backend {
    10%     commerce;
    *       legacy_orders;
}

server {
    listen 80;

    location /api/v1/inventory/ { proxy_pass http://commerce; }         # 이전 완료
    location /api/v1/orders/    { proxy_pass http://$orders_backend; }  # 10% 전환 중
    location /api/v1/payments/  { proxy_pass http://legacy_payments; }  # 아직 이전 전
}
```

`proxy_pass`에 URI 부분 없이 호스트만 주면 요청 URI가 그대로 전달되므로, 백엔드가 같은 경로를 처리하기만 하면 된다. 변수로 지정한 `$orders_backend`는 먼저 같은 이름의 `upstream` 그룹에서 찾는다.

`split_clients`는 주어진 문자열을 MurmurHash2로 해시해 비율대로 값을 나눈다. 같은 사용자는 항상 같은 쪽으로 가므로, 한 사용자가 요청마다 옛 서비스와 새 서비스를 오가며 다른 결과를 보는 일이 없다. 해시 키 헤더가 없는 요청은 모두 빈 문자열로 해시되어 한쪽으로 몰리므로, 인증 후 게이트웨이가 넣는 사용자 식별 헤더처럼 항상 존재하는 값을 쓴다.

## 라우팅 테이블: NestJS 게이트웨이

인증, 사용자별 전환, 응답 비교처럼 로직이 필요하면 NestJS 앱을 게이트웨이로 두고 `http-proxy-middleware`(v3)로 프록시할 수 있다.

```typescript
import { NestFactory } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { AppModule } from './app.module';

interface Route {
  prefix: string;
  legacy: string;
  next: string;
  percent: number; // next로 보낼 비율 0~100
}

const ROUTES: Route[] = [
  { prefix: '/api/v1/inventory', legacy: 'http://inventory-svc:3000', next: 'http://commerce:3000', percent: 100 },
  { prefix: '/api/v1/orders',    legacy: 'http://orders-svc:3000',    next: 'http://commerce:3000', percent: 10 },
];

function bucketOf(userId: string): number {
  return parseInt(createHash('sha1').update(userId).digest('hex').slice(0, 8), 16) % 100;
}

function pickTarget(req: IncomingMessage): string {
  const route = ROUTES.find((r) => req.url?.startsWith(r.prefix));
  if (!route) return 'http://legacy-monolith:3000';
  const userId = String(req.headers['x-user-id'] ?? '');
  return bucketOf(userId) < route.percent ? route.next : route.legacy;
}

async function bootstrap() {
  // 본문을 파싱하지 않아야 POST 본문이 그대로 전달된다
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  app.use(
    createProxyMiddleware({
      target: 'http://legacy-monolith:3000',
      router: pickTarget,
      pathFilter: (path) => path.startsWith('/api/'),
      changeOrigin: true,
      proxyTimeout: 10_000,
      on: {
        proxyRes: (proxyRes, req) => {
          proxyRes.headers['x-served-by'] = pickTarget(req).includes('commerce') ? 'next' : 'legacy';
        },
      },
    }),
  );

  await app.listen(3000);
}
bootstrap();
```

| 설정 | 이유 |
|---|---|
| `bodyParser: false` | Nest가 본문을 먼저 읽으면 프록시할 본문 스트림이 비어 있다. 파싱이 필요하면 `fixRequestBody`를 `on.proxyReq`에 건다 |
| `app.use`를 루트에 두고 `pathFilter` 사용 | Express는 `app.use('/api', ...)`처럼 마운트하면 경로 앞부분을 떼고 넘기므로, 전체 경로를 유지하려면 루트에 둔다 |
| `router` 함수 | 요청마다 대상을 고른다. 전환 비율을 바꾸는 것은 `ROUTES` 값 변경이다 |
| `proxyTimeout` | 대상이 응답하지 않을 때의 상한 |

`ROUTES`를 코드에 두면 비율을 바꿀 때마다 배포해야 한다. 설정 저장소나 환경 변수에서 읽어 오면 배포 없이 조정할 수 있다. `x-served-by` 같은 헤더는 어느 쪽이 응답했는지 로그와 장애 분석에서 바로 구분하게 해 준다. 단, `x-user-id`는 클라이언트가 보낸 값을 믿지 말고 게이트웨이가 토큰을 검증한 뒤 직접 채운다.

## 섀도 트래픽으로 먼저 비교한다

실제 사용자를 새 서비스로 보내기 전에, 같은 요청을 새 서비스에도 보내 결과를 비교한다. 이를 섀도 트래픽(Shadow Traffic) 또는 병행 실행(Dual Run)이라고 한다. 사용자에게는 옛 서비스의 응답만 돌려준다.

nginx는 `mirror` 지시어(1.13.4부터)로 원래 요청을 백그라운드 하위 요청으로 복제할 수 있고, 복제 요청의 응답은 버린다.

```nginx
location /api/v1/orders/ {
    mirror /_shadow;
    mirror_request_body off;
    proxy_pass http://legacy_orders;
}

location = /_shadow {
    internal;
    if ($request_method != GET) { return 204; }   # 읽기 요청만 복제
    proxy_pass http://commerce$request_uri;
    proxy_set_header X-Shadow "1";
}
```

섀도 트래픽에서 가장 중요한 규칙은 **쓰기 요청을 복제하지 않는 것**이다. 주문 생성 요청을 새 서비스에도 보내면 주문이 두 번 만들어지거나, 새 서비스가 운영 DB를 공유하는 경우 실제 데이터가 바뀐다. 쓰기 경로는 새 서비스가 운영 데이터에 쓰지 않는 모드(`X-Shadow` 헤더를 보고 커밋하지 않는 등)를 갖추거나, 비교 없이 소량 전환으로 검증한다.

nginx는 응답을 버리기만 하므로 비교는 별도로 해야 한다. 새 서비스가 섀도 요청의 응답과 요청 ID를 로그로 남기고, 옛 서비스 응답과 요청 ID로 짝지어 비교하는 방식이 흔하다. 비교 전에 시각, 생성 ID, 배열 순서처럼 원래 달라도 되는 필드는 정규화한다.

| 비교 항목 | 기준 |
|---|---|
| 상태 코드 | 일치해야 함 |
| 응답 본문 | 정규화 후 일치. 불일치는 경로별 비율로 집계 |
| 지연 시간 | p50, p99를 옛 서비스와 비교 |
| 오류율 | 새 서비스의 5xx 비율 |

## 점진적 전환

비교 결과가 안정되면 실제 트래픽을 조금씩 옮긴다. 각 단계에서 볼 지표와 다음 단계로 넘어가는 조건을 미리 정해 둔다.

| 단계 | 비율 | 넘어가는 조건(예) |
|---|---|---|
| 섀도 | 0%(비교만) | 불일치율이 정한 기준 이하, 원인이 파악된 불일치만 남음 |
| 카나리(Canary) | 1~5% | 오류율·지연이 옛 서비스와 같은 수준으로 일정 기간 유지 |
| 확대 | 25% → 50% | 피크 시간대를 한 번 이상 통과 |
| 완료 | 100% | 옛 서비스로 가는 트래픽이 없음을 확인 후 일정 기간 유지 |

전환 단위는 서비스 전체가 아니라 **경로**다. 읽기 경로(조회)를 먼저, 쓰기 경로를 나중에 옮기면 문제가 생겼을 때 영향이 작다.

## API 버전과 폐기 헤더

내부 구조만 바뀌고 응답 계약이 같다면 버전을 올릴 필요가 없다. 합치는 김에 응답 형식을 바꿔야 한다면 `/api/v2/...`처럼 새 버전 경로를 열고, 옛 버전은 일정 기간 유지하면서 폐기를 알린다. 이때 쓸 수 있는 표준 헤더가 두 가지다.

| 헤더 | 문서 | 의미 |
|---|---|---|
| `Deprecation` | RFC 9745(2025년 3월, 표준 트랙) | 리소스가 폐기되었거나 폐기될 시점. 값은 `@` + Unix 시각 |
| `Sunset` | RFC 8594(2019년, Informational) | 리소스가 응답하지 않게 될 것으로 예상되는 시점. HTTP-date 형식 |

`Deprecation`은 오랫동안 IETF 드래프트로 쓰이다가 2025년 3월 RFC 9745로 발행되었다. RFC 9745는 `Sunset` 시각이 `Deprecation` 시각보다 앞서면 안 된다고 규정하고, 폐기 안내 문서를 가리키는 `deprecation` 링크 관계를 정의한다. RFC 8594도 `sunset` 링크 관계를 정의한다.

```http
HTTP/1.1 200 OK
Deprecation: @1759276799
Sunset: Wed, 31 Dec 2025 23:59:59 GMT
Link: <https://developer.example.com/migrate/orders-v2>; rel="deprecation"; type="text/html"
```

`@1759276799`는 2025-09-30T23:59:59Z다. 두 헤더의 날짜 형식이 다르다는 점에 주의한다. 게이트웨이에서 옛 버전 경로에만 이 헤더를 붙이면 백엔드 코드를 건드리지 않고 폐기를 알릴 수 있다. `Sunset`은 약속이 아니라 예고이므로, 그 시점 이후 실제로 응답을 끊기 전에 해당 경로의 호출 클라이언트(사용자 에이전트, 앱 버전)를 로그로 확인한다.

## 롤백

게이트웨이 라우팅의 가장 큰 장점은 되돌리기가 설정 변경이라는 점이다. 비율을 0으로 돌리면 즉시 옛 서비스로 돌아간다. 단, 이것이 성립하려면 **데이터가 되돌릴 수 있는 상태**여야 한다.

| 데이터 구성 | 롤백 가능성 |
|---|---|
| 새 서비스가 옛 서비스와 같은 DB·테이블을 읽고 씀 | 라우팅만 되돌리면 됨 |
| 새 서비스가 자기 DB에 쓰고, 옛 DB로 동기화 | 동기화가 정상이면 가능, 지연·실패 시 데이터 차이 발생 |
| 새 서비스만 새 DB에 쓰고 동기화 없음 | 전환 이후 쓰인 데이터가 옛 서비스에 없음. 사실상 되돌릴 수 없음 |

그래서 전환 중에는 **한 데이터의 쓰기 주인을 하나로 유지**한다. 데이터 이전은 라우팅 전환이 끝나고 안정된 뒤 별도 단계로 진행한다. 롤백 절차(어떤 설정을 어떤 값으로 바꾸는지, 누가 판단하는지)는 전환 전에 문서로 정해 두고, 카나리 단계에서 한 번 실제로 되돌려 보는 것이 좋다.

## 정리

1. 스트랭글러 피그는 기존 시스템을 한 번에 바꾸지 않고, 이음매에서 동작을 조금씩 새 시스템으로 옮기는 방식이다. HTTP API에서는 게이트웨이가 그 이음매다.
2. 공개 경로와 응답 형식을 백엔드 구조와 분리된 계약으로 고정하면, 서비스를 합치거나 옮겨도 라우팅만 바뀐다.
3. 라우팅은 경로 접두사 단위로 하고, 비율 전환은 사용자 기준 해시로 고정해 같은 사용자가 양쪽을 오가지 않게 한다.
4. 실제 전환 전에 읽기 요청만 섀도 트래픽으로 복제해 정규화한 응답을 비교한다. 쓰기 요청은 복제하지 않는다.
5. 응답 계약이 바뀌면 새 버전 경로를 열고, 옛 경로에는 `Deprecation`(RFC 9745)과 `Sunset`(RFC 8594) 헤더로 폐기를 알린다.
6. 롤백은 라우팅 설정 변경이지만, 전환 중 데이터의 쓰기 주인이 하나일 때만 안전하다.
