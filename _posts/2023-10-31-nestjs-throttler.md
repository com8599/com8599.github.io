---
layout: post
title: "@nestjs/throttler로 요청 속도 제한(Rate Limiting) 걸기"
date: 2023-10-31
tags: [nestjs]
description: 속도 제한 알고리즘의 차이, @nestjs/throttler v4와 v5의 설정 차이, 여러 인스턴스와 프록시 환경에서 주의할 점.
---

속도 제한(rate limiting)은 클라이언트가 일정 시간 동안 보낼 수 있는 요청 수를 제한하는 것이다. 로그인 엔드포인트에 대한 무차별 대입(brute force), 크롤러의 과도한 호출, 실수로 무한 루프에 빠진 클라이언트로부터 서버를 보호한다. NestJS에서는 공식 패키지 `@nestjs/throttler`가 Guard 형태로 이 기능을 제공한다.

## 알고리즘

| 알고리즘 | 방식 | 장점 | 단점 |
|---|---|---|---|
| 고정 윈도우(fixed window) | 시간을 1분 같은 구간으로 자르고 구간마다 카운터를 센다. | 키 하나, 카운터 하나로 단순하다. | 구간 경계 직전·직후에 몰아 보내면 짧은 시간에 한도의 두 배까지 통과한다. |
| 슬라이딩 로그(sliding log) | 요청 시각을 모두 저장하고 최근 `ttl` 안의 개수를 센다. | 경계 문제가 없고 정확하다. | 요청마다 기록이 남아 메모리를 많이 쓴다. |
| 슬라이딩 윈도우 카운터(sliding window counter) | 이전 구간 카운트를 경과 비율만큼 가중해 현재 구간과 합친다. | 메모리가 적고 경계 문제를 완화한다. | 근사치다. |
| 토큰 버킷(token bucket) | 버킷에 일정 속도로 토큰이 채워지고, 요청마다 토큰 하나를 쓴다. | 평균 속도를 지키면서 순간적인 몰림(burst)을 버킷 크기만큼 허용한다. | 상태(토큰 수, 마지막 충전 시각)를 원자적으로 갱신해야 한다. |

`@nestjs/throttler`의 설정은 `ttl`(기간)과 `limit`(그 기간 안에 허용할 요청 수) 두 값이다. 기본 메모리 저장소는 키마다 누적 횟수를 두고, 요청이 들어올 때마다 횟수를 1 올린 뒤 `ttl`이 지나면 그 요청분을 다시 1 내린다. 즉 각 요청이 자기 시점부터 `ttl` 뒤에 개별적으로 빠지므로, 동작은 고정 윈도우보다 슬라이딩 로그에 가깝다. 토큰 버킷처럼 충전 속도와 버킷 크기를 따로 지정하는 방식은 제공하지 않는다.

## v4와 v5의 차이

`@nestjs/throttler`는 2023년 9월 v5.0.0이 나오면서 설정 방식이 바뀌었다. 변경 내역(CHANGELOG)에 정리된 주요 변경 사항은 다음과 같다.

| 항목 | v4 | v5 |
|---|---|---|
| `ttl` 단위 | 초 | **밀리초** |
| 모듈 옵션 | 객체 하나 `{ ttl, limit }` | 배열 `[{ name, ttl, limit }]` 또는 `{ throttlers: [...] }` |
| 여러 제한 동시 적용 | 불가 | 이름 붙은 throttler 여러 개 |
| `@Throttle()` | `@Throttle(limit, ttl)` | `@Throttle({ default: { limit, ttl } })` |
| `@SkipThrottle()` | `@SkipThrottle(true)` | `@SkipThrottle({ default: true })` |
| `ttl`, `limit` 생략 | 가능 | 불가(반드시 지정) |
| `getTracker()` | 동기 | 비동기 가능 |
| 시간 헬퍼 | 없음 | `seconds()`, `minutes()`, `hours()`, `days()`, `weeks()` |

가장 주의할 부분은 단위다. v4에서 `ttl: 60`은 60초였지만 v5에서는 60밀리초다. 옵션을 배열로 감싸기만 하고 값을 그대로 두면 사실상 제한이 사라진다. 읽기 쉽게 초 단위로 쓰고 싶다면 패키지가 내보내는 `seconds()` 헬퍼를 쓴다. 이 헬퍼는 단순히 1000을 곱한다.

```ts
// v4
ThrottlerModule.forRoot({ ttl: 60, limit: 10 });

// v5
ThrottlerModule.forRoot([{ ttl: seconds(60), limit: 10 }]);
```

이름을 지정하지 않은 throttler의 이름은 `'default'`다. v5의 데코레이터에서 키로 쓰는 값이 바로 이 이름이다.

## 기본 설정 (v5)

```bash
npm i @nestjs/throttler
```

```ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, seconds, minutes } from '@nestjs/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'short', ttl: seconds(1), limit: 3 },
      { name: 'long', ttl: minutes(1), limit: 100 },
    ]),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

throttler가 여러 개면 요청은 **모두**를 통과해야 한다. 위 설정은 초당 3회, 분당 100회를 동시에 적용한다.

`ThrottlerGuard`는 저장소와 옵션을 주입받아야 하므로 `useGlobalGuards()`가 아니라 `APP_GUARD` provider로 등록한다. Guard이므로 요청 파이프라인에서 Middleware 다음, Interceptor와 Pipe 이전에 실행된다. 즉 본문 검증이나 핸들러 실행 전에 차단된다.

## 라우트별 조정

```ts
@Controller('auth')
export class AuthController {
  @Throttle({ short: { limit: 1, ttl: seconds(1) }, long: { limit: 5, ttl: minutes(1) } })
  @Post('login')
  login() {}
}

@SkipThrottle()
@Controller('health')
export class HealthController {
  @Get()
  check() {}

  @SkipThrottle({ default: false })
  @Get('deep')
  deep() {}
}
```

| 데코레이터 | 적용 대상 | 의미 |
|---|---|---|
| `@Throttle({ 이름: { limit, ttl } })` | 클래스, 메서드 | 해당 이름의 throttler 값을 덮어쓴다. |
| `@SkipThrottle()` | 클래스, 메서드 | 기본값 `{ default: true }`로 `'default'` throttler를 건너뛴다. |
| `@SkipThrottle({ 이름: false })` | 메서드 | 클래스에서 건너뛰도록 한 것을 다시 켠다. |

이름 붙은 throttler만 쓰는 설정에서 `@SkipThrottle()`을 인자 없이 붙이면 `'default'`만 건너뛰므로 아무 효과가 없다. 건너뛸 이름을 `@SkipThrottle({ short: true, long: true })`처럼 모두 적어야 한다. 5.0.0에는 이 객체의 첫 번째 키만 반영되는 문제가 있었고 5.0.1에서 고쳐졌으므로, 여러 이름을 한 번에 넘긴다면 5.0.1 이상을 쓴다.

메서드의 메타데이터가 클래스의 메타데이터보다 우선한다.

## 제한은 라우트 단위로 센다

`ThrottlerGuard`는 저장소 키를 `컨트롤러 클래스 이름 + 핸들러 이름 + throttler 이름 + 추적 값(tracker)`으로 만든다. 그래서 `limit: 100`은 "이 클라이언트가 전체 API에 100회"가 아니라 "이 클라이언트가 **각 라우트에** 100회"라는 뜻이다. 사용자 단위 전체 한도가 필요하면 `generateKey()`를 재정의해 라우트 정보를 빼야 한다.

추적 값은 기본적으로 `req.ip`다. 로그인한 사용자 기준으로 세고 싶다면 `getTracker()`를 재정의한다.

```ts
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.id ? `user:${req.user.id}` : req.ip;
  }
}
```

이 Guard가 `req.user`를 보려면 인증 Guard가 먼저 실행되어야 한다. 전역 Guard는 등록 순서대로 실행되므로 인증 Guard의 `APP_GUARD`를 먼저 선언한다.

## 프록시 뒤에서 클라이언트 IP

로드 밸런서나 리버스 프록시 뒤에서 `req.ip`는 프록시의 주소가 된다. 그러면 모든 사용자가 같은 IP로 집계되어 한 사용자의 요청이 전체를 막는다.

Express 어댑터에서는 `trust proxy`를 설정하면 Express가 `X-Forwarded-For`를 해석해 `req.ip`를 클라이언트 주소로 돌려준다.

```ts
const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.set('trust proxy', 'loopback'); // 신뢰할 프록시 주소나 대역, 또는 홉 수
```

Fastify 어댑터는 `new FastifyAdapter({ trustProxy: true })`처럼 생성자 옵션으로 지정한다.

공식 문서는 `req.ips`의 첫 번째 값을 추적 값으로 쓰는 예를 보여 준다.

```ts
@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.ips.length ? req.ips[0] : req.ip;
  }
}
```

`req.ip`와 `req.ips`를 어떻게 계산할지는 `trust proxy` 설정이 결정한다. 신뢰할 프록시 주소를 정확히 지정하면 Express는 `X-Forwarded-For`를 오른쪽(가까운 홉)부터 읽다가 **신뢰하지 않는 첫 주소**에서 멈추고, 그 주소를 클라이언트 IP로 본다. 반대로 `trust proxy`를 `true`로 두면 모든 홉을 신뢰해 가장 왼쪽 값을 클라이언트 IP로 쓰는데, 이 값은 클라이언트가 헤더에 직접 넣어 보낼 수 있다. 프록시가 기존 헤더를 지우지 않고 뒤에 덧붙이기만 하면, 공격자는 요청마다 다른 값을 넣어 매번 새 클라이언트처럼 보이게 만들 수 있다. 어떤 추적 값을 쓰든 `trust proxy`는 `true`가 아니라 실제 프록시의 주소, 대역, 또는 홉 수로 지정한다.

## 여러 인스턴스와 저장소

기본 저장소는 프로세스 메모리다. 인스턴스가 3대면 각자 따로 세므로 실제 한도는 설정값의 3배가 되고, 재시작하면 카운트가 사라진다. 여러 인스턴스가 같은 카운트를 보려면 Redis 같은 공유 저장소를 쓴다.

공식 패키지에는 Redis 저장소가 없고 커뮤니티 패키지 `nestjs-throttler-storage-redis`를 쓴다. `@nestjs/throttler` v5와 함께 쓰려면 0.4.1 이상을 설치한다.

```bash
npm i nestjs-throttler-storage-redis ioredis
```

```ts
import { ThrottlerModule, seconds } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from 'nestjs-throttler-storage-redis';
import Redis from 'ioredis';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ ttl: seconds(60), limit: 100 }],
        storage: new ThrottlerStorageRedisService(new Redis(config.get('REDIS_URL'))),
      }),
    }),
  ],
})
export class AppModule {}
```

저장소를 지정할 때는 옵션을 배열이 아니라 `throttlers` 속성을 가진 객체로 넘긴다. 직접 저장소를 만들 때는 `ThrottlerStorage` 인터페이스의 `increment(key, ttl)`을 구현해 `{ totalHits, timeToExpire }`를 반환하면 된다. 이때 증가와 만료 설정이 원자적으로 이루어져야 여러 인스턴스가 동시에 세도 숫자가 어긋나지 않는다.

## 429 응답과 헤더

한도를 넘으면 `ThrottlerException`이 발생하고 응답은 `429 Too Many Requests`, 기본 메시지는 `ThrottlerException: Too Many Requests`다. `ThrottlerGuard`는 응답에 다음 헤더를 붙인다.

| 헤더 | 값 | 붙는 시점 |
|---|---|---|
| `X-RateLimit-Limit` | `limit` | 통과한 요청 |
| `X-RateLimit-Remaining` | 남은 요청 수 | 통과한 요청 |
| `X-RateLimit-Reset` | 기록이 만료될 때까지 남은 초 | 통과한 요청 |
| `Retry-After` | 다시 시도할 수 있을 때까지 남은 초 | 429 응답 |

이름 붙은 throttler는 헤더 이름 뒤에 `-이름`이 붙는다(`X-RateLimit-Remaining-long`). `'default'`만 접미사가 없다.

`Retry-After`는 HTTP 표준 헤더로, `Retry-After: 120`처럼 초 단위 정수나 HTTP 날짜를 값으로 갖는다. 429 응답에서는 새 요청을 보내기 전 기다려야 할 시간을, 503 응답에서는 서비스가 사용할 수 없을 것으로 예상되는 시간을 뜻한다. 클라이언트는 429를 받으면 이 값만큼 기다린 뒤 재시도하도록 구현하고, 값이 없으면 지수 백오프(exponential backoff)를 쓴다.

`ttl`은 밀리초로 지정하지만 헤더 값은 초 단위로 내려간다는 점도 기억해 둔다.

## 정리

- 고정 윈도우는 단순하지만 경계에서 두 배까지 통과하고, 슬라이딩 방식과 토큰 버킷은 이를 완화한다. `@nestjs/throttler`의 기본 저장소는 요청마다 개별 만료되는 방식이다.
- v5부터 `ttl`은 밀리초이고, 옵션은 이름 붙은 throttler 배열이며, `@Throttle()`과 `@SkipThrottle()`은 이름을 키로 갖는 객체를 받는다. 업그레이드할 때 `seconds()`로 단위를 맞춘다.
- `ThrottlerGuard`는 `APP_GUARD`로 등록하고, 한도는 라우트마다 따로 센다.
- 프록시 뒤에서는 `trust proxy`를 `true`가 아니라 실제 프록시의 주소나 홉 수로 지정해, 클라이언트가 보낸 `X-Forwarded-For` 값을 그대로 믿지 않게 한다.
- 인스턴스가 여러 대면 `nestjs-throttler-storage-redis` 같은 공유 저장소를 쓴다.
- 한도를 넘으면 429와 `Retry-After` 헤더가 나가고, 통과한 응답에는 `X-RateLimit-*` 헤더가 붙는다.
