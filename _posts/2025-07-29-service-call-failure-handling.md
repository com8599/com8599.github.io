---
layout: post
title: 서비스 간 호출의 실패 처리 — 타임아웃, 재시도, 멱등성 키(Idempotency Key)
date: 2025-07-29
tags: [nestjs]
description: 다른 서비스를 HTTP로 부를 때 필요한 타임아웃과 마감 시간 전파, 재시도해도 되는 요청의 조건, 지수 백오프와 지터, 재시도 증폭, 서킷 브레이커, 그리고 멱등성 키의 저장·만료·충돌 처리.
---

서비스 간 HTTP 호출은 세 가지로 끝난다. 성공, 실패, 그리고 **모름**이다. 응답이 오기 전에 연결이 끊기거나 타임아웃이 나면 호출한 쪽은 상대가 요청을 처리했는지 알 수 없다. 이 "모름"을 어떻게 다루느냐가 실패 처리의 핵심이다. 그냥 다시 보내면 결제가 두 번 될 수 있고, 다시 보내지 않으면 처리되지 않은 요청이 버려진다.

이 글은 타임아웃, 재시도, 멱등성(Idempotency)을 하나의 흐름으로 정리하고, NestJS의 `@nestjs/axios`와 RxJS로 구현한다. 기준 버전은 NestJS 11, `@nestjs/axios` 4, RxJS 7이다.

## 타임아웃: 기다림에 상한을 둔다

타임아웃이 없는 호출은 상대가 멈추면 함께 멈춘다. axios의 `timeout` 기본값은 `0`, 즉 **타임아웃 없음**이다. 그리고 응답을 기다리는 동안 요청은 메모리, 소켓, DB 커넥션 같은 자원을 붙잡고 있으므로, 느린 하위 서비스 하나가 호출자의 자원을 고갈시켜 관계없는 기능까지 실패하게 만든다.

타임아웃에는 단계가 있다.

| 종류 | 의미 | 너무 길면 | 너무 짧으면 |
|---|---|---|---|
| 연결(Connect) | TCP/TLS 연결 수립까지 | 죽은 호스트에 오래 매달림 | 일시적 지연에도 실패 |
| 읽기(Read/Idle) | 데이터 수신 사이의 무활동 시간 | 멈춘 응답을 오래 기다림 | 큰 응답이 끊김 |
| 전체(Deadline) | 요청 시작부터 응답 완료까지 | 호출자 전체가 느려짐 | 정상 요청도 실패 |

Node.js에서 axios의 `timeout`은 내부적으로 `request.setTimeout()`을 쓰는데, 이는 소켓이 연결된 뒤 **무활동 시간**을 재는 타이머다. 데이터가 조금씩 계속 들어오는 응답은 이 값보다 오래 걸려도 끊기지 않는다. 전체 시간의 상한은 별도로 둬야 하며, 아래 예시에서는 RxJS의 `timeout` 연산자로 건다.

값을 정하는 기준으로 AWS Builders' Library의 "Timeouts, retries, and backoff with jitter"는 허용할 거짓 타임아웃 비율(예: 0.1%)을 먼저 정하고, 하위 서비스 지연 분포의 해당 백분위(예: p99.9)를 타임아웃으로 쓰는 방법을 제시한다. 평균이 아니라 꼬리 지연을 기준으로 삼는다는 점이 중요하다.

### 마감 시간 전파

호출이 여러 단계를 거치면 단계별 타임아웃만으로는 부족하다. 게이트웨이가 3초 뒤에 포기했는데 하위 서비스는 그 뒤에도 계속 일을 하고, 그 아래 서비스를 또 부른다. 아무도 기다리지 않는 결과를 위해 자원을 쓰는 셈이다.

마감 시간 전파(Deadline Propagation)는 최상위에서 정한 마감을 하위 호출에 넘겨, 각 단계가 **남은 시간**만큼만 기다리게 하는 방식이다. gRPC는 이를 프로토콜 수준의 데드라인으로 지원하지만 HTTP에는 표준 헤더가 없으므로, 팀이 정한 헤더(여기서는 `x-request-timeout-ms`)로 남은 시간을 넘긴다. 시계 차이를 피하려면 절대 시각보다 남은 밀리초를 넘기는 편이 낫다.

```typescript
const remaining = deadline - Date.now();
if (remaining <= 50) throw new GatewayTimeoutException('deadline exceeded before call');
headers['x-request-timeout-ms'] = String(remaining - 20); // 네트워크 여유분
```

## 재시도해도 되는 요청

타임아웃 뒤의 재시도가 안전한지는 HTTP 메서드의 의미에 달려 있다. RFC 9110은 메서드를 다음처럼 정의한다.

| 메서드 | 안전(Safe) | 멱등(Idempotent) | 자동 재시도 |
|---|---|---|---|
| GET, HEAD, OPTIONS, TRACE | O | O | 가능 |
| PUT, DELETE | X | O | 가능 |
| POST, PATCH | X | X | 멱등성을 보장하는 수단이 있을 때만 |

멱등은 같은 요청을 여러 번 보내도 서버에 의도된 효과가 한 번 보낸 것과 같다는 뜻이다. RFC 9110은 클라이언트가 요청 의미가 실제로 멱등임을 알거나 원래 요청이 적용되지 않았음을 확인할 수단이 없으면 **비멱등 요청을 자동으로 재시도해서는 안 된다(SHOULD NOT)** 고 쓴다. 그 "수단"이 뒤에서 다룰 멱등성 키다.

메서드 외에 오류 종류도 본다.

| 결과 | 재시도 | 이유 |
|---|---|---|
| 연결 실패(요청 전송 전) | 가능 | 서버가 요청을 받지 못했다 |
| 응답 전 연결 끊김, 타임아웃 | 멱등일 때만 | 처리됐는지 모른다 |
| 502, 503, 504 | 멱등일 때만 | 일시적 장애일 가능성이 높다 |
| 429 | `Retry-After`를 지켜서 | 상대가 속도를 제한 중이다([속도 제한 글](/2023/10/31/nestjs-throttler/) 참고) |
| 그 밖의 4xx | 하지 않음 | 같은 요청은 같은 이유로 다시 실패한다 |

## 백오프와 지터

실패 직후 바로 재시도하면 아직 회복되지 않은 상대를 다시 두드린다. 지수 백오프(Exponential Backoff)는 재시도 간격을 시도마다 두 배씩 늘리고, 상한(cap)을 둔다. 그런데 클라이언트 수백 개가 같은 순간에 실패했다면 백오프 간격도 같아서 같은 순간에 다시 몰린다. 지터(Jitter)는 간격에 무작위성을 섞어 재시도를 시간축에 흩뜨린다.

AWS Architecture Blog의 "Exponential Backoff And Jitter"가 비교한 방식 중 가장 단순한 것은 Full Jitter다.

```text
sleep = random_between(0, min(cap, base * 2 ^ attempt))
```

같은 글의 시뮬레이션에서 지터가 없는 지수 백오프는 작업량과 완료 시간 모두 가장 나빴고, Full Jitter는 호출 수를 크게 줄였다.

## 재시도 증폭

재시도는 이기적이다. 한 클라이언트의 성공 확률을 높이는 대신 서버 용량을 더 쓴다. 상대가 과부하로 실패하고 있다면 재시도는 과부하를 키운다.

여러 계층이 각자 재시도하면 문제가 곱으로 커진다. 게이트웨이 → 서비스 A → 서비스 B → DB 구조에서 각 계층이 최대 3회 시도(최초 1회 + 재시도 2회)하면, 맨 아래에는 최대 3 × 3 × 3 = 27배의 요청이 도착한다. 장애 상황에서 이 증폭이 회복을 막는 재시도 폭풍(Retry Storm)이 된다.

| 대응 | 방법 |
|---|---|
| 한 지점에서만 재시도 | 앞의 AWS 글은 스택의 한 지점에서만 재시도하라고 권한다. 하위 계층은 빨리 실패를 돌려준다 |
| 재시도 예산 | 토큰 버킷(Token Bucket)으로 재시도를 제한해, 토큰이 떨어지면 재시도를 멈추거나 낮은 비율로만 허용 |
| 서킷 브레이커 | 실패가 계속되면 호출 자체를 잠시 막는다 |
| 마감 시간 전파 | 남은 시간이 없으면 재시도하지 않는다 |

Azure Architecture Center의 Retry 패턴 문서도 같은 이유로 하위 작업은 빨리 실패하고 상위 작업이 자신의 정책으로 처리하라고 권한다.

## 서킷 브레이커

서킷 브레이커(Circuit Breaker)는 실패할 가능성이 높은 호출을 아예 보내지 않는 프록시다. Azure Architecture Center의 정의에 따르면 세 상태를 가진다.

| 상태 | 동작 | 전이 |
|---|---|---|
| 닫힘(Closed) | 호출을 통과시키고 일정 시간 창의 실패 수를 센다 | 실패가 임계치를 넘으면 열림, 타이머 시작 |
| 열림(Open) | 호출하지 않고 즉시 실패(또는 기본값)를 돌려준다 | 타이머가 끝나면 반열림 |
| 반열림(Half-Open) | 제한된 수의 요청만 통과시킨다 | 성공이 이어지면 닫힘, 하나라도 실패하면 다시 열림 |

재시도와 함께 쓸 때는 **재시도가 브레이커를 거쳐** 호출하고, 브레이커가 열려 있다는 오류는 재시도하지 않아야 한다. Node.js에서는 opossum 같은 라이브러리를 쓰거나, 서비스 메시(Service Mesh)가 있다면 인프라 수준에서 처리할 수 있다. AWS 글은 서킷 브레이커가 테스트하기 어렵고 회복이 느릴 수 있다는 이유로 로컬 토큰 버킷 방식의 재시도 제한을 선호한다고 밝히고 있으므로, 둘 중 하나를 고를 때 참고한다.

## NestJS 구현: HttpService + RxJS

`@nestjs/axios`의 `HttpService` 메서드는 구독할 때마다 요청을 보내는 Observable을 돌려준다. 그래서 RxJS `retry`가 재구독하면 새 HTTP 요청이 나가고, `timeout`으로 구독이 끊기면 내부에서 axios 요청을 취소한다.

```typescript
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { AxiosRequestConfig, isAxiosError } from 'axios';
import { firstValueFrom, throwError, timer, TimeoutError } from 'rxjs';
import { retry, timeout } from 'rxjs/operators';

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const RETRYABLE_STATUS = new Set([502, 503, 504]);

interface CallPolicy {
  attemptTimeoutMs: number; // 시도 1회의 상한
  deadlineMs: number;       // 재시도 포함 전체 상한
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

@Injectable()
export class ResilientHttp {
  constructor(private readonly http: HttpService) {}

  async request<T>(config: AxiosRequestConfig, policy: CallPolicy): Promise<T> {
    const method = (config.method ?? 'GET').toUpperCase();
    const hasIdempotencyKey = Boolean(config.headers?.['Idempotency-Key']);
    const canRetry = IDEMPOTENT_METHODS.has(method) || hasIdempotencyKey;

    const res = await firstValueFrom(
      this.http.request<T>(config).pipe(
        timeout({ first: policy.attemptTimeoutMs }),
        retry({
          count: canRetry ? policy.maxRetries : 0,
          delay: (error, retryCount) => {
            if (!isRetryable(error)) {
              return throwError(() => error);
            }
            const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retryCount);
            return timer(Math.random() * ceiling); // Full Jitter
          },
        }),
        timeout({ first: policy.deadlineMs }),
      ),
    );
    return res.data;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (!isAxiosError(error)) return false;
  if (!error.response) return true; // ECONNRESET, ECONNREFUSED 등 네트워크 오류
  return RETRYABLE_STATUS.has(error.response.status);
}
```

| 연산자 위치 | 효과 |
|---|---|
| `retry` 앞의 `timeout` | 시도마다 적용. 시간을 넘긴 시도는 취소되고 재시도 대상이 된다 |
| `retry` 뒤의 `timeout` | 재시도와 대기 시간을 포함한 전체 상한 |
| `retry`의 `delay` 함수 | 오류 종류를 보고 재시도 여부와 대기 시간을 결정. `throwError`를 돌려주면 즉시 중단 |

비멱등 요청은 `count: 0`으로 재시도하지 않고, 멱등성 키를 붙인 경우에만 재시도를 허용했다. 429의 `Retry-After`를 따르려면 `delay` 함수에서 응답 헤더를 읽어 그 시간만큼 `timer`를 돌려주면 된다.

## 멱등성 키 설계

POST를 안전하게 재시도하려면 서버가 "이 요청은 이미 처리했다"를 알아볼 수 있어야 한다. 클라이언트가 **논리적 작업 하나마다** 고유한 키를 만들어 헤더로 보내고, 서버는 키별로 첫 처리 결과를 저장해 같은 키의 재요청에는 저장된 결과를 돌려준다.

IETF httpapi 워킹 그룹의 "The Idempotency-Key HTTP Header Field"는 이 헤더를 표준화하려는 문서로, 이 글을 쓰는 시점에는 RFC가 아닌 **인터넷 드래프트(Internet-Draft, -06 판)** 상태다. 드래프트는 값으로 UUID 같은 무작위 식별자를 권하고, 다음 응답을 제안한다.

| 상황 | 드래프트가 제안하는 응답 |
|---|---|
| 키가 필수인 엔드포인트에 키가 없음 | 400 Bad Request |
| 같은 키, 다른 요청 본문 | 422 Unprocessable Content |
| 같은 키의 첫 요청이 아직 처리 중 | 409 Conflict |
| 키 만료 | 리소스가 만료 정책을 정하고 문서에 공개 |

Stripe API 문서는 실제 운영 사례로 참고할 만하다. 키는 최대 255자이고 V4 UUID 등 충분히 무작위인 값을 권하며, 엔드포인트 실행이 시작된 뒤의 첫 결과(500 오류 포함)를 저장해 재시도에 그대로 돌려준다. 키는 생성 후 최소 24시간이 지나면 정리될 수 있고(정리된 뒤 같은 키가 오면 새 요청으로 처리), 같은 키로 들어온 파라미터가 원래 요청과 다르면 오류를 낸다. 파라미터 검증에 실패했거나 동시에 실행 중인 요청과 충돌한 경우에는 결과를 저장하지 않으므로 다시 시도할 수 있다.

### 저장 구조

```sql
CREATE TABLE idempotency_keys (
  scope_key       VARCHAR(300) PRIMARY KEY,  -- 클라이언트 ID + ':' + 키
  request_hash    CHAR(64)     NOT NULL,     -- 정규화한 요청 본문의 SHA-256
  status          VARCHAR(16)  NOT NULL,     -- PROCESSING | COMPLETED
  response_status INT          NULL,
  response_body   JSON         NULL,
  locked_until    DATETIME(3)  NOT NULL,
  expires_at      DATETIME(3)  NOT NULL,
  INDEX idx_expires_at (expires_at)
);
```

| 결정 | 선택과 이유 |
|---|---|
| 키 범위 | 클라이언트(또는 사용자)별로 묶는다. 다른 클라이언트의 같은 키와 충돌하지 않게 |
| 요청 지문(Fingerprint) | 본문 해시를 저장해 같은 키·다른 본문을 감지 |
| 저장 위치 | 비즈니스 데이터와 같은 DB. 결과 저장과 비즈니스 쓰기를 한 트랜잭션으로 묶을 수 있다 |
| 만료(TTL) | 클라이언트 재시도 기간보다 길게(예: 24시간). 만료 행은 배치로 삭제 |
| 처리 중 잠금 | `locked_until`로 처리 중 표시. 프로세스가 죽어 잠금이 남으면 만료 후 다시 처리 |

Redis로 처리 중 잠금을 잡는 구현도 흔하지만, 잠금과 비즈니스 쓰기가 다른 저장소에 있으면 둘 사이에서 프로세스가 죽었을 때 상태가 어긋난다.

### 처리 흐름

```typescript
async createPayment(clientId: string, key: string, dto: CreatePaymentDto) {
  const scopeKey = `${clientId}:${key}`;
  const requestHash = sha256(canonicalJson(dto));
  const now = Date.now();

  try {
    await this.prisma.idempotencyKey.create({
      data: {
        scopeKey,
        requestHash,
        status: 'PROCESSING',
        lockedUntil: new Date(now + 30_000),
        expiresAt: new Date(now + 24 * 60 * 60 * 1000),
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return this.replay(scopeKey, requestHash); // 같은 키가 이미 있음
    }
    throw e;
  }

  try {
    return await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({ data: toPayment(clientId, dto) });
      await tx.idempotencyKey.update({
        where: { scopeKey },
        data: { status: 'COMPLETED', responseStatus: 201, responseBody: payment },
      });
      return payment;
    });
  } catch (e) {
    // 트랜잭션이 롤백되어 아무것도 반영되지 않았으므로 같은 키로 다시 시도할 수 있게 한다
    await this.prisma.idempotencyKey.delete({ where: { scopeKey } });
    throw e;
  }
}

private async replay(scopeKey: string, requestHash: string) {
  const saved = await this.prisma.idempotencyKey.findUniqueOrThrow({ where: { scopeKey } });
  if (saved.requestHash !== requestHash) {
    throw new UnprocessableEntityException('Idempotency-Key reused with a different body');
  }
  if (saved.status === 'PROCESSING') {
    throw new ConflictException('A request with this Idempotency-Key is in progress');
  }
  return saved.responseBody; // 첫 요청과 같은 결과
}
```

동시에 같은 키로 두 요청이 들어오면 기본 키 제약 때문에 하나만 `create`에 성공하고, 나머지는 `P2002`(고유 제약 위반)로 `replay`에 들어가 409를 받는다. 잠금을 "읽고 나서 쓰는" 방식으로 구현하면 두 요청이 모두 "없음"을 읽고 함께 처리할 수 있으므로, 반드시 DB의 고유 제약으로 원자적으로 판정한다.

외부 결제 대행사 호출처럼 트랜잭션 밖의 부수 효과가 있는 처리에서는 실패 시 키를 지우면 안 된다. 외부에는 이미 반영됐을 수 있기 때문이다. 이때는 키를 `PROCESSING`으로 남기고 상태 조회로 실제 결과를 확인한 뒤 완료 처리하며, 외부 호출에도 같은 멱등성 키를 넘긴다.

클라이언트 쪽 규칙은 하나다. **키는 재시도마다 새로 만들지 않고, 논리적 작업마다 한 번 만든다.** 재시도할 때 새 키를 만들면 서버는 다른 요청으로 보고 다시 처리한다.

## 정리

1. 모든 원격 호출에 시도별 타임아웃과 전체 마감을 둔다. axios의 `timeout`은 Node.js에서 무활동 타이머이므로 전체 상한은 따로 건다.
2. 남은 시간을 하위 호출로 전파해 아무도 기다리지 않는 작업을 줄인다.
3. 자동 재시도는 멱등 메서드(GET, HEAD, OPTIONS, PUT, DELETE)와 일시적 오류(네트워크, 502·503·504)에만 하고, 4xx는 재시도하지 않는다.
4. 재시도 간격은 상한이 있는 지수 백오프에 지터를 더하고, 재시도는 스택의 한 지점에서만 한다.
5. 지속되는 장애에는 서킷 브레이커나 재시도 예산으로 호출 자체를 줄인다.
6. POST를 재시도하려면 멱등성 키를 쓴다. 키 범위, 본문 해시, 처리 중 잠금, 만료를 정하고, 같은 키·다른 본문은 422, 처리 중 중복은 409로 응답한다. IETF 표준은 2025년 현재 드래프트 단계다.
