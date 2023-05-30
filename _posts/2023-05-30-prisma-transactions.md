---
layout: post
title: Prisma 트랜잭션 — 중첩 쓰기, 배치, 인터랙티브 트랜잭션
date: 2023-05-30
tags: [nestjs]
description: Prisma가 제공하는 세 가지 트랜잭션 방식의 차이와, 예약·결제처럼 동시성이 걸린 쓰기를 짧고 안전하게 처리하는 방법.
---

Prisma에서 여러 쓰기를 원자적으로 묶는 방법은 하나가 아니다. 관계로 연결된 레코드를 한 번에 쓰는 **중첩 쓰기**(nested writes), 쿼리 배열을 한 트랜잭션으로 보내는 **순차 실행**(sequential operations), 함수 안에서 로직과 쿼리를 섞는 **인터랙티브 트랜잭션**(interactive transactions)이 있다. `updateMany`, `deleteMany`, `createMany` 같은 벌크 연산도 그 자체로 하나의 트랜잭션으로 실행된다. 방식마다 표현할 수 있는 범위와 DB 커넥션을 붙잡는 시간이 다르므로, 가장 약한 도구로 충분한지부터 따진다.

아래 예시는 MySQL에서 코치의 수업 슬롯을 예약하고 결제 기록을 남기는 흐름이다.

```prisma
model Slot {
  id       Int        @id @default(autoincrement())
  coachId  Int
  startsAt DateTime
  status   SlotStatus @default(OPEN)
  version  Int        @default(0)
  booking  Booking?
}

model Booking {
  id        Int      @id @default(autoincrement())
  slotId    Int      @unique
  slot      Slot     @relation(fields: [slotId], references: [id])
  userId    Int
  payment   Payment?
  createdAt DateTime @default(now())
}

model Payment {
  id             Int           @id @default(autoincrement())
  bookingId      Int           @unique
  booking        Booking       @relation(fields: [bookingId], references: [id])
  amount         Int
  status         PaymentStatus @default(PENDING)
  idempotencyKey String        @unique
}

enum SlotStatus {
  OPEN
  BOOKED
}

enum PaymentStatus {
  PENDING
  PAID
  FAILED
}
```

`Booking.slotId`의 `@unique`는 1:1 관계를 위해 필요한 제약이면서, "한 슬롯에 예약은 하나"라는 규칙을 DB가 보장하게 만드는 마지막 방어선이기도 하다.

## 중첩 쓰기

서로 ID로 연결된 레코드를 함께 만들 때는 중첩 쓰기가 가장 단순하다. 부모의 ID가 생성된 뒤에야 자식을 쓸 수 있는 **종속 쓰기**(dependent writes)를 Prisma가 한 트랜잭션 안에서 순서대로 처리하고, 하나라도 실패하면 전체를 롤백한다.

```ts
const booking = await prisma.booking.create({
  data: {
    slot: { connect: { id: slotId } },
    userId,
    payment: {
      create: { amount, idempotencyKey },
    },
  },
  include: { payment: true },
});
```

한계도 분명하다. 중간 결과를 보고 분기할 수 없고, `updateMany`·`deleteMany` 같은 최상위 벌크 연산에는 중첩 쓰기를 붙일 수 없다. 위 코드도 슬롯 상태를 `BOOKED`로 바꾸는 일은 하지 못한다.

## 배치: $transaction 배열

서로 독립적인 쿼리 여러 개를 하나의 트랜잭션으로 묶을 때는 `$transaction`에 쿼리 배열을 넘긴다. 쿼리는 배열 순서대로 실행되고, 결과도 같은 순서의 배열로 돌아온다.

```ts
const [slot, booking] = await prisma.$transaction([
  prisma.slot.update({
    where: { id: slotId },
    data: { status: 'BOOKED' },
  }),
  prisma.booking.create({
    data: { slotId, userId },
  }),
]);
```

배열 안의 쿼리는 `$transaction`을 호출하기 전에 이미 만들어진 상태라서, 앞 쿼리의 결과를 뒤 쿼리의 입력으로 쓸 수 없다. 위 코드도 슬롯이 이미 예약됐는지 확인하지 못한다. 다만 두 번째 사용자가 같은 슬롯을 예약하면 `Booking.slotId` 유니크 제약 위반(P2002)으로 두 번째 쿼리가 실패하고, 트랜잭션 전체가 롤백된다. 판단을 제약 조건에 맡길 수 있으면 배열 방식으로도 충분하다. 4.4.0부터는 두 번째 인자로 `isolationLevel`을 줄 수 있다.

## 인터랙티브 트랜잭션

중간 결과를 보고 분기해야 하면 `$transaction`에 async 함수를 넘긴다. 함수가 받는 `tx`로 실행한 쿼리만 트랜잭션에 포함되고, 함수가 정상 종료하면 커밋, 예외를 던지면 롤백한다. 2.29.0부터 프리뷰 기능(`interactiveTransactions`)이었고, 4.7.0에서 정식(GA) 기능이 됐다.

```ts
async book(slotId: number, userId: number, amount: number, idempotencyKey: string) {
  return this.prisma.$transaction(
    async (tx) => {
      const claimed = await tx.slot.updateMany({
        where: { id: slotId, status: 'OPEN' },
        data: { status: 'BOOKED', version: { increment: 1 } },
      });
      if (claimed.count === 0) {
        throw new ConflictException('이미 예약된 슬롯입니다.');
      }

      return tx.booking.create({
        data: {
          slotId,
          userId,
          payment: { create: { amount, idempotencyKey } },
        },
        include: { payment: true },
      });
    },
    {
      maxWait: 2000,
      timeout: 5000,
    },
  );
}
```

두 번째 인자의 옵션은 다음과 같다.

| 옵션 | 의미 | 기본값 |
|---|---|---|
| `maxWait` | Prisma Client가 DB에서 트랜잭션을 얻기까지 기다리는 최대 시간 | 2000ms |
| `timeout` | 트랜잭션이 실행될 수 있는 최대 시간. 넘으면 취소되고 롤백된다 | 5000ms |
| `isolationLevel` | 트랜잭션 격리 수준(isolation level) | DB 설정값 (MySQL은 `RepeatableRead`) |

`isolationLevel`은 인터랙티브 트랜잭션에서 4.2.0부터, 배열 방식에서 4.4.0부터 지정할 수 있다. 값은 `Prisma.TransactionIsolationLevel.Serializable`처럼 쓰고, MySQL은 `ReadUncommitted`, `ReadCommitted`, `RepeatableRead`, `Serializable`을 지원한다.

## 조건부 업데이트와 낙관적 동시성 제어

위 예약 코드의 핵심은 "읽고 판단하고 쓰기"를 하지 않는 것이다. `findUnique`로 상태를 읽고 `OPEN`이면 `update`하는 식으로 짜면, 두 요청이 동시에 `OPEN`을 읽고 둘 다 쓸 수 있다. 대신 조건을 `where`에 넣어 판단과 쓰기를 한 문장으로 만들고, 영향받은 행 수(`count`)로 성공 여부를 판단한다. `updateMany`를 쓰는 이유는 `count`를 돌려주고, 4.x의 `update`는 `where`에 유니크 필드만 받기 때문이다.

상태 컬럼 하나로 표현되지 않는 변경에는 `version` 필드를 둔 **낙관적 동시성 제어**(Optimistic Concurrency Control, OCC)를 쓴다. 락을 잡지 않고, 읽은 시점의 버전과 쓰는 시점의 버전이 같을 때만 쓴다.

```ts
const slot = await prisma.slot.findUniqueOrThrow({ where: { id: slotId } });

// 읽은 값을 바탕으로 애플리케이션에서 계산
const nextStartsAt = reschedule(slot.startsAt, request);

const result = await prisma.slot.updateMany({
  where: { id: slotId, version: slot.version },
  data: { startsAt: nextStartsAt, version: { increment: 1 } },
});
if (result.count === 0) {
  throw new ConflictException('다른 요청이 먼저 변경했습니다. 다시 시도하세요.');
}
```

이 패턴은 트랜잭션 없이도 동작하며, 읽기와 쓰기 사이에 DB 커넥션을 붙잡지 않는다. `update`에서 유니크가 아닌 필드로 필터링하는 기능은 4.5.0부터 `extendedWhereUnique` 프리뷰로 제공되고, 그 전까지는 `updateMany`가 일반적인 방법이다.

## 멱등성: 같은 요청이 두 번 올 때

결제 요청은 네트워크 재시도나 중복 클릭으로 두 번 들어올 수 있다. 같은 입력으로 몇 번을 실행해도 DB에 미치는 효과가 같도록 **멱등**(idempotent)하게 만든다. 클라이언트가 요청마다 고유한 `idempotencyKey`를 보내고, 이 값에 유니크 제약을 건다.

```ts
try {
  return await this.book(slotId, userId, amount, idempotencyKey);
} catch (e) {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const existing = await this.prisma.payment.findUnique({
      where: { idempotencyKey },
      include: { booking: true },
    });
    if (existing) return existing.booking;
  }
  throw e;
}
```

P2002 중에는 `idempotencyKey`가 아니라 `slotId` 유니크 위반도 있으므로, 키로 기존 결과를 찾지 못하면 예외를 그대로 던진다. 앞의 요청과 같은 키라면 이미 만들어진 결과를 그대로 돌려준다.

## 긴 트랜잭션을 피하는 법

인터랙티브 트랜잭션은 함수가 끝날 때까지 커넥션 하나를 점유하고, 그동안 잡은 행 락도 유지한다. 함수 안에서 외부 결제 대행사(PG, Payment Gateway) API를 호출하면 외부 응답 시간이 그대로 락 유지 시간이 되고, 5초 기본 `timeout`을 넘기면 트랜잭션이 롤백된다. 이미 승인된 결제와 롤백된 예약이 서로 어긋나는 상황도 생긴다.

외부 호출은 트랜잭션 밖으로 빼고 상태로 단계를 나눈다.

1. **트랜잭션 1**: 슬롯을 `BOOKED`로 바꾸고 예약과 `PENDING` 결제를 만든다.
2. **트랜잭션 밖**: PG에 승인을 요청한다. 이때도 같은 `idempotencyKey`를 넘겨 PG 쪽 중복 승인을 막는다.
3. **트랜잭션 2**: 결과에 따라 결제를 `PAID`로 바꾸거나, `FAILED`로 바꾸고 슬롯을 `OPEN`으로 되돌린다(보상 처리).

2단계 이후 서버가 죽어 `PENDING`으로 남은 결제는 일정 시간 뒤 PG에 상태를 조회해 정리하는 배치로 처리한다.

트랜잭션 안에서 지켜야 할 원칙은 다음과 같다.

- 네트워크 호출, 파일 처리, 무거운 계산을 넣지 않는다.
- 필요한 데이터는 트랜잭션 시작 전에 읽어 둔다.
- `tx` 대신 바깥의 `prisma`를 실수로 쓰면 그 쿼리는 트랜잭션 밖에서 실행된다.
- `Serializable` 격리 수준이나 데드락으로 실패하면 P2034가 발생한다. 이 오류는 같은 트랜잭션을 처음부터 다시 실행하는 재시도로 처리한다.

## 정리

| | 중첩 쓰기 | `$transaction` 배열 | 인터랙티브 트랜잭션 |
|---|---|---|---|
| 용도 | 관계로 연결된 레코드 생성·수정 | 독립적인 쿼리 묶음 | 중간 결과에 따른 분기 |
| 앞 결과 사용 | 관계 연결만 | 불가 | 가능 |
| 애플리케이션 로직 | 불가 | 불가 | 가능 |
| 격리 수준 지정 | 불가 | 4.4.0부터 | 4.2.0부터 |
| 커넥션 점유 | 짧음 | 짧음 | 함수 실행 시간 전체 |

1. 관계로 묶인 생성은 중첩 쓰기, 서로 독립적인 쓰기는 배열 방식으로 시작한다.
2. "읽고 판단하고 쓰기"는 조건을 `where`에 넣은 `updateMany`와 `count` 확인으로 바꿀 수 있는지 먼저 본다.
3. 그래도 분기가 필요할 때만 인터랙티브 트랜잭션을 쓰고, 안에서 외부 호출을 하지 않는다.
4. 중복 요청은 유니크 제약이 걸린 멱등성 키로 막고, 제약 위반을 기존 결과 반환으로 처리한다.
