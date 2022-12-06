---
layout: post
title: 소켓 게임 서버의 동시성 — 같은 방의 이벤트 직렬화
date: 2022-12-06
tags: [game-server]
description: 싱글 스레드인 Node에서도 await 사이에 경쟁 조건이 생기는 이유와 해결 방법.
---

Node.js는 싱글 스레드라 동시성 문제가 없다고 생각하기 쉽다. 하지만 `await`에서 제어가 이벤트 루프로 돌아가면 다른 요청이 끼어든다. **읽기 → await → 쓰기** 구조라면 경쟁 조건(race condition)이 생긴다.

## 문제 코드

```ts
@SubscribeMessage('hit')
async hit(@ConnectedSocket() client: Socket, @MessageBody() { tableId }: HitDto) {
  const table = await this.tableRepo.get(tableId);   // 1. 읽기
  const card = table.deck.shift();                   // 2. 맨 위 카드
  table.hands[client.data.userId].push(card);
  await this.tableRepo.save(table);                  // 3. 쓰기
  this.server.to(tableId).emit('dealt', { card });
}
```

같은 테이블에 `hit` 두 개가 거의 동시에 들어오면:

| 순서 | 요청 A | 요청 B |
|---|---|---|
| 1 | `get(table)` → `deck = [K, 3, ...]` | |
| 2 | | `get(table)` → `deck = [K, 3, ...]` (A가 저장하기 전) |
| 3 | `shift()` → `K`, `save` | |
| 4 | | `shift()` → `K`, `save` |

같은 카드가 두 번 나간다. 클라이언트 버튼 비활성화로는 막을 수 없다. 중복 클릭, 재연결 시 리스너 중복 등록, 악의적 요청 모두 서버에 도달한다.

## 해결 1: 방 단위 직렬화 (단일 인스턴스)

같은 테이블의 액션을 큐에 넣어 하나씩 처리한다.

```ts
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.tails.set(key, next);
    const cleanup = () => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }
}

// gateway
@SubscribeMessage('hit')
hit(@ConnectedSocket() client: Socket, @MessageBody() dto: HitDto) {
  return this.mutex.run(dto.tableId, () => this.game.hit(client.data.userId, dto));
}
```

서로 다른 테이블은 병렬로, 같은 테이블은 순서대로 처리된다. 앞 작업이 실패해도 `prev.catch`로 다음 작업은 실행되고, 실패는 그 작업을 호출한 쪽에만 전달된다. 정리에 `next.finally(...)`를 쓰면 `finally`가 만든 새 Promise가 `next`의 rejection을 그대로 이어받아 처리되지 않은 rejection이 되므로, `then(cleanup, cleanup)`으로 성공과 실패를 모두 받는다.

## 해결 2: 원자적 연산 (상태가 Redis에 있을 때)

덱을 Redis List로 두면 카드 뽑기 자체가 원자적(atomic)이다. Redis 명령 하나는 다른 클라이언트의 명령과 섞이지 않고 실행된다.

```ts
const card = await redis.lpop(`table:${tableId}:deck`);
```

여러 키를 함께 바꿔야 하면 Lua 스크립트나 `MULTI`/`WATCH`(낙관적 락, optimistic locking)를 쓴다.

## 해결 3: 다중 인스턴스

서버가 여러 대면 프로세스 내 뮤텍스(mutex)로는 부족하다.

- **방 라우팅**: 같은 테이블은 항상 같은 인스턴스가 처리하게 한다. 상태와 처리 주체가 한 곳에 있어 가장 단순하다.
- **분산 락(distributed lock)**: `SET lock:table:{id} {token} NX PX 3000`으로 획득하고, 해제는 토큰이 일치할 때만 `DEL`하는 Lua 스크립트로 한다. 처리 시간이 만료 시간보다 길어지면 다른 인스턴스가 락을 얻을 수 있으므로 락 만료와 처리 시간의 관계를 신경 써야 한다.

## 멱등성(idempotency)과 턴 검증

직렬화해도 같은 요청이 두 번 오면 두 번 처리된다. 클라이언트가 자신이 본 상태를 함께 보내게 한다.

```ts
interface ActionDto {
  tableId: string;
  turn: number;       // 클라이언트가 본 턴 번호
  actionId: string;   // 요청 고유 ID
}
```

- `turn`이 현재 턴과 다르면 거절한다.
- 처리한 `actionId`를 기록해 재전송을 무시한다.

## 정리

| 위험 | 대응 |
|---|---|
| await 사이 끼어들기 | 방 단위 직렬화 |
| 여러 키 동시 변경 | 원자적 연산, 트랜잭션 |
| 다중 인스턴스 | 방 라우팅 또는 분산 락 |
| 중복·지연 요청 | 턴 번호, 액션 ID |

게임 서버에서는 서버가 상태의 유일한 주인이어야 하고, 모든 액션은 현재 상태에 대한 검증을 거쳐야 한다.
