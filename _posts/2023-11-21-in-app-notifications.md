---
layout: post
title: 인앱 알림 설계 — 읽음 처리와 안 읽은 개수 집계
date: 2023-11-21
tags: [nestjs]
description: 알림 데이터 모델, 읽음 처리, 안 읽은 개수를 COUNT로 셀지 카운터로 둘지의 선택과 그에 따른 일관성 문제를 MongoDB 기준으로 정리한다.
---

인앱 알림은 기능 자체는 단순해 보이지만, 화면 상단의 빨간 숫자 하나가 거의 모든 요청에서 조회된다. 목록 조회보다 "안 읽은 개수" 조회가 훨씬 자주 일어나고, 읽음 처리와 새 알림 생성이 동시에 일어나면 숫자가 어긋나기 쉽다. 여기서는 MongoDB에 알림을 저장한다는 전제로 데이터 모델, 읽음 처리, 개수 집계, 실시간 전달, 중복 방지를 차례로 다룬다.

## 데이터 모델: 수신자별 문서와 읽기 시 팬아웃

알림을 저장하는 방식은 크게 두 가지다.

| | 수신자별 문서(쓰기 시 팬아웃) | 공용 문서 + 읽음 기록(읽기 시 팬아웃) |
|---|---|---|
| 저장 | 수신자 수만큼 문서 생성 | 알림 1개 + 사용자별 읽음 상태 |
| 읽음 처리 | 해당 문서의 `readAt` 갱신 | 사용자별 읽음 기록 추가 또는 마지막 읽은 시각 갱신 |
| 안 읽은 개수 | 사용자 기준 단일 조건 조회 | 공용 알림과 읽음 기록을 비교 |
| 적합한 경우 | 예약 확정, 메시지, 결제처럼 개인 대상 알림 | 전체 공지, 대상이 매우 많은 알림 |

**팬아웃**(fan-out)은 하나의 이벤트를 여러 수신자에게 퍼뜨리는 것을 말한다. 개인 대상 알림이 대부분이면 수신자별 문서가 조회와 읽음 처리 모두 단순하다. 전체 공지는 별도 컬렉션에 두고 사용자별 "마지막으로 확인한 공지 시각"만 저장해, 그 이후에 생성된 공지 수를 안 읽은 개수에 더한다. 이렇게 하면 수십만 명에게 공지를 보낼 때 문서를 수십만 개 쓰지 않아도 된다.

## 스키마와 인덱스

```ts
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class Notification {
  @Prop({ required: true })
  userId: number;

  @Prop({ required: true })
  type: string;                       // 'BOOKING_CONFIRMED' 등

  @Prop({ type: Object })
  payload: Record<string, unknown>;   // 화면 표시와 이동에 필요한 값

  @Prop({ type: Date, default: null })
  readAt: Date | null;

  @Prop()
  dedupKey?: string;

  createdAt: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index(
  { userId: 1, dedupKey: 1 },
  { unique: true, partialFilterExpression: { dedupKey: { $exists: true } } },
);
```

읽음 여부를 불리언 대신 `readAt` 시각으로 두면 "언제 읽었는지"도 남고, `readAt: null` 조건으로 안 읽은 알림을 고를 수 있다. `{ readAt: null }`은 필드가 없는 문서도 함께 찾으므로, 기본값을 `null`로 명시해 모든 문서의 모양을 맞춘다.

인덱스는 쿼리 모양에 맞춘다. 복합 인덱스의 필드 순서는 **동등 조건(Equality) → 정렬(Sort) → 범위(Range)** 순서로 두는 ESR 규칙을 따른다.

| 쿼리 | 사용 인덱스 |
|---|---|
| 안 읽은 알림 목록 (`userId`, `readAt: null`, `createdAt` 내림차순) | `{ userId: 1, readAt: 1, createdAt: -1 }` |
| 안 읽은 개수 (`userId`, `readAt: null`) | 위 인덱스의 접두사 |
| 전체 알림 목록 (`userId`, `createdAt` 내림차순) | `{ userId: 1, createdAt: -1 }` |

전체 목록은 `readAt` 조건이 없어서 첫 번째 인덱스로는 `createdAt` 순서를 바로 얻을 수 없다. 두 화면이 모두 있으면 인덱스도 두 개 둔다. 오래된 알림은 TTL 인덱스로 자동 삭제할 수 있다.

## 읽음 처리

```ts
async markRead(userId: number, id: string) {
  const res = await this.model.updateOne(
    { _id: id, userId, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return res.modifiedCount === 1;
}
```

필터에 `userId`를 넣어 다른 사용자의 알림을 바꾸지 못하게 하고, `readAt: null`을 넣어 이미 읽은 알림은 건드리지 않는다. 같은 요청이 두 번 와도 두 번째는 `modifiedCount`가 0이므로, 이 값을 기준으로 뒤에 나올 카운터를 줄이면 중복 차감이 생기지 않는다.

모두 읽음은 `updateMany`로 처리한다.

```ts
async markAllRead(userId: number) {
  const res = await this.model.updateMany(
    { userId, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return res.modifiedCount;
}
```

`updateMany`는 문서 하나하나에 대해서는 원자적이지만 여러 문서 전체를 하나의 원자적 작업으로 처리하지는 않는다. 실행 도중 새로 들어온 알림은 처리될 수도, 안 될 수도 있다. "누른 시점까지의 알림만 읽음"을 정확히 지키려면 조건에 `createdAt: { $lte: clickedAt }`을 추가한다.

## 안 읽은 개수: 매번 세기와 카운터

### 매번 세기

```ts
countUnread(userId: number) {
  return this.model.countDocuments({ userId, readAt: null }, { limit: 100 });
}
```

`countDocuments`는 `$match`와 `$group`으로 된 집계를 실행해 조건에 맞는 문서를 실제로 센다. 컬렉션 메타데이터를 쓰는 추정치가 아니므로 항상 정확하다. 위 인덱스가 있으면 한 사용자의 안 읽은 알림 범위만 훑는다. 다만 `readAt: null` 조건은 값이 `null`인 문서와 필드가 없는 문서를 인덱스만으로 구분하지 못해 문서를 함께 읽으므로(FETCH), 인덱스만으로 끝나는 커버드 쿼리(covered query)는 되지 않는다.

비용은 안 읽은 알림 수에 비례한다. 화면에 "99+"까지만 보여 준다면 `limit` 옵션으로 세는 상한을 두어 비용의 상한도 함께 정한다.

### 비정규화 카운터

사용자별 상태 문서에 개수를 따로 저장하고, 생성·읽음 시점에 `$inc`로 더하고 뺀다.

```ts
// 알림 생성 후
await this.stateModel.updateOne(
  { userId },
  { $inc: { unreadCount: 1 } },
  { upsert: true },
);

// 읽음 처리로 modifiedCount 만큼 차감
await this.stateModel.updateOne(
  { userId },
  { $inc: { unreadCount: -modified } },
);
```

`$inc`는 한 문서 안에서 원자적이라 동시에 들어온 증가·감소가 서로 덮어쓰지 않는다. 필드가 없으면 지정한 값으로 만들어 주므로 첫 알림에서 따로 초기화할 필요도 없다. 다만 값이 `null`인 필드에 `$inc`를 하면 오류가 나므로 `null`로 초기화하지 않는다.

모두 읽음에서 카운터를 `0`으로 덮어쓰지 않고 `-modifiedCount`만큼 빼는 이유는, `updateMany`와 카운터 갱신 사이에 새 알림이 들어와 `+1`된 값을 지우지 않기 위해서다.

### 비교

| | `countDocuments` | 카운터 + `$inc` |
|---|---|---|
| 정확성 | 항상 정확 | 알림 문서와 카운터 갱신이 별개라 어긋날 수 있음 |
| 조회 비용 | 안 읽은 수에 비례 (`limit`으로 상한) | 문서 1개 조회 |
| 쓰기 비용 | 없음 | 생성·읽음마다 추가 쓰기 |
| 장애 복구 | 필요 없음 | 재계산 작업 필요 |

알림 저장과 카운터 증가는 두 번의 쓰기이므로, 사이에서 프로세스가 죽으면 카운터가 어긋난다. 다중 문서 트랜잭션으로 묶을 수도 있지만 레플리카 셋이 필요하고 비용이 든다. 카운터를 쓸 때는 다음을 함께 둔다.

- 값이 음수가 되면 0으로 보정하고 재계산을 예약한다.
- 알림 목록을 열 때처럼 정확성이 중요한 시점에 `countDocuments`로 다시 세어 카운터를 덮어쓴다.
- 주기적으로 일부 사용자를 샘플링해 실제 개수와 비교한다.

안 읽은 알림이 많아야 수십 개이고 `limit`으로 상한을 둘 수 있다면, 인덱스를 탄 `countDocuments`로 충분한 경우가 많다. 카운터는 조회 빈도가 매우 높아 측정상 병목이 확인된 뒤 도입한다.

## 중복 알림 방지

같은 이벤트가 재시도나 메시지 큐의 중복 전달로 두 번 처리되면 알림도 두 번 생긴다. 이벤트마다 결정적인 `dedupKey`(예: `booking:123:confirmed`)를 만들고 `{ userId, dedupKey }`에 유니크 인덱스를 건다.

유니크 인덱스는 필드가 없는 문서를 `null`로 색인하므로, 키가 없는 알림이 두 개만 돼도 충돌한다. 위 스키마처럼 `partialFilterExpression: { dedupKey: { $exists: true } }`를 주면 유니크 제약이 키가 있는 문서에만 적용된다.

```ts
async create(input: CreateNotificationInput) {
  try {
    const doc = await this.model.create(input);
    await this.incrementUnread(input.userId);
    return doc;
  } catch (e) {
    if (e?.code === 11000) return null;   // duplicate key: 이미 생성된 알림
    throw e;
  }
}
```

중복으로 판정되면 카운터도 올리지 않고 실시간 전송도 하지 않는다. 저장 성공을 기준으로 후속 작업을 실행하면 생성 경로 전체가 멱등해진다.

## 실시간 전달

저장이 먼저이고 전송은 그다음이다. 소켓은 "새 알림이 있다"는 신호일 뿐, 데이터의 원본은 DB다.

1. 알림을 저장하고 카운터를 갱신한다.
2. 사용자 전용 방(예: `user:42`)으로 알림 요약과 새 안 읽은 개수를 보낸다.
3. 클라이언트는 받은 알림을 목록 앞에 붙이고 배지를 갱신한다.
4. 재연결하거나 앱이 포그라운드로 돌아오면, 마지막으로 받은 알림 이후를 API로 다시 조회한다.

연결이 끊겨 있던 동안의 알림은 소켓으로 전달되지 않으므로 4번이 반드시 필요하다. 서버가 여러 대면 사용자가 다른 서버에 연결돼 있을 수 있어, Redis 어댑터처럼 서버 간에 이벤트를 전달하는 구성이 필요하다. 앱이 꺼져 있는 사용자에게는 푸시 알림을 따로 보낸다.

## 정리

1. 개인 알림은 수신자별 문서로, 전체 공지는 공용 문서와 사용자별 확인 시각으로 저장한다.
2. 읽음은 `readAt` 시각으로 표현하고 기본값을 `null`로 명시한다.
3. 인덱스는 ESR 순서로, 화면의 쿼리 모양마다 맞춘다.
4. 읽음 처리 조건에 `readAt: null`을 넣고 `modifiedCount`로 실제 변경 여부를 판단한다.
5. 안 읽은 개수는 인덱스를 탄 `countDocuments`와 `limit`으로 시작하고, 카운터는 병목이 확인된 뒤 재계산 수단과 함께 도입한다.
6. 중복은 `dedupKey` 부분 유니크 인덱스로 막고, 저장 성공을 기준으로 카운터와 전송을 실행한다.
7. 소켓은 신호, DB는 원본이다. 재연결 시 놓친 알림을 다시 조회한다.
